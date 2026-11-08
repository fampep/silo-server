// Package grok signs Silo in to a Grok subscription and keeps an xAI API-key
// provider separate. Plan tokens are only sent to the Grok CLI chat proxy.
package grok

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Silo-Server/silo-server/internal/ai/llm"
	"github.com/Silo-Server/silo-server/internal/config"
)

// CredentialsKey is the encrypted setting that holds the Grok plan session.
const CredentialsKey = "ai.grok.credentials"

const (
	clientID  = "b1a00492-073a-47ea-816f-4c329264a828"
	scope     = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write"
	grantType = "urn:ietf:params:oauth:grant-type:device_code"
)

// ErrSignInRequired means text requests need a connected Grok plan.
var ErrSignInRequired = errors.New("sign in with Grok in AI Services")

// Store is the settings store the plan session is saved in.
type Store interface {
	Get(context.Context, string) (string, error)
	UpdateValueAtomic(context.Context, string, func(string) (string, error)) error
}

// Status is the plan connection without tokens or the device code.
type Status struct {
	Connected       bool   `json:"connected"`
	Email           string `json:"email,omitempty"`
	LoginPending    bool   `json:"login_pending"`
	UserCode        string `json:"user_code,omitempty"`
	VerificationURI string `json:"verification_uri,omitempty"`
	Message         string `json:"message,omitempty"`
}

// Login is a device-code sign-in the administrator finishes in a browser.
type Login struct {
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
}

// Model is one chat model the plan can use.
type Model struct {
	ID string `json:"id"`
}

type credentials struct {
	AccessToken     string    `json:"access_token,omitempty"`
	RefreshToken    string    `json:"refresh_token,omitempty"`
	Expiry          time.Time `json:"expiry,omitempty"`
	Email           string    `json:"email,omitempty"`
	NeedsLogin      bool      `json:"needs_login,omitempty"`
	DeviceCode      string    `json:"device_code,omitempty"`
	UserCode        string    `json:"user_code,omitempty"`
	VerificationURI string    `json:"verification_uri,omitempty"`
	DeviceExpiry    time.Time `json:"device_expiry,omitempty"`
}

// Service performs the Grok plan device login and refreshes its session.
type Service struct {
	store     Store
	deviceURL string
	tokenURL  string
	modelsURL string
	client    *http.Client
}

// NewService returns a plan client for store.
func NewService(store Store) *Service {
	return &Service{
		store:     store,
		deviceURL: "https://auth.x.ai/oauth2/device/code",
		tokenURL:  "https://auth.x.ai/oauth2/token",
		modelsURL: "https://cli-chat-proxy.grok.com/v1/models",
		client: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func decode(raw string) (credentials, error) {
	if strings.TrimSpace(raw) == "" {
		return credentials{}, nil
	}
	var c credentials
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return credentials{}, errors.New("stored Grok session is unreadable")
	}
	return c, nil
}

func (s *Service) load(ctx context.Context) (credentials, error) {
	raw, err := s.store.Get(ctx, CredentialsKey)
	if err != nil {
		return credentials{}, err
	}
	return decode(raw)
}

func (s *Service) mutate(ctx context.Context, fn func(*credentials) error) error {
	return s.store.UpdateValueAtomic(ctx, CredentialsKey, func(raw string) (string, error) {
		c, err := decode(raw)
		if err != nil {
			return "", err
		}
		if err := fn(&c); err != nil {
			return "", err
		}
		buf, err := json.Marshal(c)
		if err != nil {
			return "", err
		}
		return string(buf), nil
	})
}

func publicStatus(c credentials) Status {
	pending := c.DeviceCode != "" && time.Now().Before(c.DeviceExpiry)
	return Status{
		Connected:       c.RefreshToken != "" && !c.NeedsLogin,
		Email:           c.Email,
		LoginPending:    pending,
		UserCode:        c.UserCode,
		VerificationURI: c.VerificationURI,
	}
}

// Status reports the plan connection.
func (s *Service) Status(ctx context.Context) (Status, error) {
	c, err := s.load(ctx)
	if err != nil {
		return Status{}, err
	}
	return publicStatus(c), nil
}

// StartLogin begins a device-code sign-in. An existing session stays until the
// new sign-in succeeds.
func (s *Service) StartLogin(ctx context.Context) (Login, error) {
	form := url.Values{"client_id": {clientID}, "scope": {scope}}
	var started struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
	}
	if err := s.post(ctx, s.deviceURL, form, &started); err != nil {
		return Login{}, err
	}
	if started.DeviceCode == "" || started.UserCode == "" || started.VerificationURI == "" {
		return Login{}, errors.New("Grok sign-in did not return a device code")
	}
	if started.ExpiresIn <= 0 {
		started.ExpiresIn = 900
	}
	expires := time.Now().Add(time.Duration(started.ExpiresIn) * time.Second)
	if err := s.mutate(ctx, func(c *credentials) error {
		c.DeviceCode = started.DeviceCode
		c.UserCode = started.UserCode
		c.VerificationURI = started.VerificationURI
		c.DeviceExpiry = expires
		return nil
	}); err != nil {
		return Login{}, err
	}
	return Login{UserCode: started.UserCode, VerificationURI: started.VerificationURI, ExpiresIn: started.ExpiresIn}, nil
}

// Poll exchanges a pending device code once. authorization_pending leaves the
// sign-in pending so the browser can ask again.
func (s *Service) Poll(ctx context.Context) (Status, error) {
	current, err := s.load(ctx)
	if err != nil {
		return Status{}, err
	}
	if current.DeviceCode == "" {
		return publicStatus(current), nil
	}
	if !current.DeviceExpiry.IsZero() && time.Now().After(current.DeviceExpiry) {
		if err := s.clearDevice(ctx); err != nil {
			return Status{}, err
		}
		st := publicStatus(current)
		st.LoginPending = false
		st.UserCode = ""
		st.VerificationURI = ""
		st.Message = "Grok sign-in expired. Start again."
		return st, nil
	}
	form := url.Values{
		"client_id":   {clientID},
		"device_code": {current.DeviceCode},
		"grant_type":  {grantType},
	}
	var token tokenResponse
	var oauthErr oauthError
	if err := s.postOAuth(ctx, form, &token, &oauthErr); err != nil {
		return Status{}, err
	}
	switch oauthErr.Error {
	case "", "authorization_pending", "slow_down":
		if oauthErr.Error != "" || token.AccessToken == "" {
			st := publicStatus(current)
			st.LoginPending = true
			return st, nil
		}
	case "expired_token", "access_denied":
		if err := s.clearDevice(ctx); err != nil {
			return Status{}, err
		}
		st := publicStatus(current)
		st.LoginPending = false
		st.Message = "Grok sign-in was not completed."
		return st, nil
	default:
		return Status{}, errors.New("Grok sign-in failed")
	}
	if token.RefreshToken == "" {
		token.RefreshToken = current.RefreshToken
	}
	if token.AccessToken == "" || token.RefreshToken == "" {
		return Status{}, errors.New("Grok sign-in did not return a session")
	}
	email := tokenEmail(token.IDToken)
	if err := s.mutate(ctx, func(c *credentials) error {
		if c.DeviceCode != current.DeviceCode {
			return errors.New("Grok sign-in changed")
		}
		c.AccessToken = token.AccessToken
		c.RefreshToken = token.RefreshToken
		c.Expiry = token.expiry()
		c.NeedsLogin = false
		c.DeviceCode = ""
		c.UserCode = ""
		c.VerificationURI = ""
		c.DeviceExpiry = time.Time{}
		if email != "" {
			c.Email = email
		}
		return nil
	}); err != nil {
		return Status{}, err
	}
	return s.Status(ctx)
}

// Disconnect forgets the plan session.
func (s *Service) Disconnect(ctx context.Context) (Status, error) {
	if err := s.mutate(ctx, func(c *credentials) error {
		*c = credentials{}
		return nil
	}); err != nil {
		return Status{}, err
	}
	return Status{}, nil
}

// Models lists plan models, falling back to the current Grok chat models.
func (s *Service) Models(ctx context.Context) ([]Model, error) {
	token, err := s.bearerToken(ctx)
	if err != nil {
		return defaultModels(), nil
	}
	live, err := s.liveModels(ctx, token)
	if err != nil || len(live) == 0 {
		return defaultModels(), nil
	}
	return live, nil
}

func defaultModels() []Model {
	return []Model{{ID: "grok-4.7"}, {ID: "grok-4"}, {ID: "grok-3"}, {ID: "grok-3-mini"}}
}

// TextConfig attaches the plan session when Grok serves text. Otherwise it
// returns the selected API-key provider.
func (s *Service) TextConfig(ctx context.Context) (llm.Config, error) {
	values := map[string]string{}
	for _, key := range []string{
		config.AIAuthModeSettingKey,
		config.AIProvidersSettingKey,
		config.AITextProviderSettingKey,
		config.AIServiceTierSettingKey,
		"ai.chat_model",
		"ai.reasoning_effort",
		CredentialsKey,
	} {
		value, err := s.store.Get(ctx, key)
		if err != nil {
			return llm.Config{}, err
		}
		values[key] = value
	}
	effective := config.EffectiveAdminSettings(values)
	baseURL, apiKey := config.ResolveAIEndpoint(effective, config.AITextProviderSettingKey, config.AICapabilityChat)
	cfg := llm.Config{
		AuthMode:        effective[config.AIAuthModeSettingKey],
		BaseURL:         baseURL,
		APIKey:          apiKey,
		ChatModel:       effective["ai.chat_model"],
		ReasoningEffort: effective["ai.reasoning_effort"],
		ServiceTier:     config.ResolveAIServiceTier(effective),
	}
	if cfg.AuthMode != llm.AuthModeGrok {
		return cfg, nil
	}
	session, err := decode(values[CredentialsKey])
	if err != nil {
		return llm.Config{}, err
	}
	if session.NeedsLogin || session.RefreshToken == "" {
		return llm.Config{}, ErrSignInRequired
	}
	cfg.BaseURL = ""
	cfg.APIKey = ""
	cfg.ServiceTier = ""
	cfg.GrokTokenSource = func(context.Context) (func(context.Context) (string, error), error) {
		return s.bearerToken, nil
	}
	cfg.GrokTokenRejected = s.RejectToken
	return cfg, nil
}

// RejectToken drops a rejected access token. The last rejection requires a new
// sign-in instead of another refresh.
func (s *Service) RejectToken(ctx context.Context, rejected string, final bool) error {
	return s.mutate(ctx, func(c *credentials) error {
		if c.AccessToken != rejected {
			return nil
		}
		c.AccessToken = ""
		c.Expiry = time.Time{}
		if final {
			c.NeedsLogin = true
		}
		return nil
	})
}

func (s *Service) bearerToken(ctx context.Context) (string, error) {
	current, err := s.load(ctx)
	if err != nil {
		return "", err
	}
	if current.NeedsLogin || current.RefreshToken == "" {
		return "", ErrSignInRequired
	}
	if current.AccessToken != "" && time.Until(current.Expiry) > 2*time.Minute {
		return current.AccessToken, nil
	}
	var token tokenResponse
	var oauthErr oauthError
	form := url.Values{
		"client_id":     {clientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {current.RefreshToken},
	}
	if err := s.postOAuth(ctx, form, &token, &oauthErr); err != nil || token.AccessToken == "" {
		_ = s.mutate(ctx, func(c *credentials) error {
			if c.RefreshToken == current.RefreshToken {
				c.NeedsLogin = true
				c.AccessToken = ""
			}
			return nil
		})
		return "", ErrSignInRequired
	}
	if token.RefreshToken == "" {
		token.RefreshToken = current.RefreshToken
	}
	if err := s.mutate(ctx, func(c *credentials) error {
		if c.RefreshToken != current.RefreshToken {
			return nil
		}
		c.AccessToken = token.AccessToken
		c.RefreshToken = token.RefreshToken
		c.Expiry = token.expiry()
		c.NeedsLogin = false
		if email := tokenEmail(token.IDToken); email != "" {
			c.Email = email
		}
		return nil
	}); err != nil {
		return "", err
	}
	return token.AccessToken, nil
}

func (s *Service) clearDevice(ctx context.Context) error {
	return s.mutate(ctx, func(c *credentials) error {
		c.DeviceCode = ""
		c.UserCode = ""
		c.VerificationURI = ""
		c.DeviceExpiry = time.Time{}
		return nil
	})
}

func (s *Service) liveModels(ctx context.Context, token string) ([]Model, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.modelsURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-XAI-Token-Auth", "xai-grok-cli")
	req.Header.Set("x-grok-client-version", llm.GrokClientVersion)
	req.Header.Set("User-Agent", "xai-grok-workspace/"+llm.GrokClientVersion)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("Grok model list failed")
	}
	var listed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &listed); err != nil {
		return nil, err
	}
	models := make([]Model, 0, len(listed.Data))
	for _, item := range listed.Data {
		if item.ID != "" {
			models = append(models, Model{ID: item.ID})
		}
	}
	return models, nil
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	IDToken      string `json:"id_token"`
}

func (t tokenResponse) expiry() time.Time {
	seconds := t.ExpiresIn
	if seconds <= 0 {
		seconds = 3600
	}
	return time.Now().Add(time.Duration(seconds) * time.Second)
}

type oauthError struct {
	Error string `json:"error"`
}

func (s *Service) post(ctx context.Context, endpoint string, form url.Values, out any) error {
	body, status, oauthErr, err := s.readForm(ctx, endpoint, form)
	if err != nil {
		return err
	}
	if oauthErr.Error != "" || status != http.StatusOK {
		return errors.New("Grok sign-in failed")
	}
	if err := json.Unmarshal(body, out); err != nil {
		return errors.New("Grok sign-in response was unreadable")
	}
	return nil
}

func (s *Service) postOAuth(ctx context.Context, form url.Values, token *tokenResponse, oauthErr *oauthError) error {
	body, status, parsed, err := s.readForm(ctx, s.tokenURL, form)
	if err != nil {
		return err
	}
	_ = json.Unmarshal(body, token)
	*oauthErr = parsed
	if status == http.StatusOK || parsed.Error != "" {
		return nil
	}
	return fmt.Errorf("Grok sign-in failed (%d)", status)
}

func (s *Service) readForm(ctx context.Context, endpoint string, form url.Values) ([]byte, int, oauthError, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, 0, oauthError{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, 0, oauthError{}, errors.New("Grok sign-in request failed")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, resp.StatusCode, oauthError{}, errors.New("Grok sign-in response was unreadable")
	}
	var oauthErr oauthError
	_ = json.Unmarshal(body, &oauthErr)
	return body, resp.StatusCode, oauthErr, nil
}

func tokenEmail(idToken string) string {
	parts := strings.Split(idToken, ".")
	if len(parts) < 2 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	return strings.TrimSpace(claims.Email)
}
