package grok

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type memStore struct {
	mu     sync.Mutex
	values map[string]string
}

func newMemStore() *memStore {
	return &memStore{values: map[string]string{}}
}

func (m *memStore) Get(_ context.Context, key string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.values[key], nil
}

func (m *memStore) UpdateValueAtomic(_ context.Context, key string, fn func(string) (string, error)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	next, err := fn(m.values[key])
	if err != nil {
		return err
	}
	m.values[key] = next
	return nil
}

func TestDeviceLoginThenRefresh(t *testing.T) {
	var tokenCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		form := string(body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "device"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_code": "device-secret", "user_code": "ABCD-EFGH",
				"verification_uri": "https://accounts.x.ai/oauth2/device", "expires_in": 600,
			})
		case strings.Contains(form, "device_code"):
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "authorization_pending"})
		case strings.Contains(form, "refresh_token"):
			tokenCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "refreshed", "refresh_token": "refresh-1", "expires_in": 3600,
			})
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer server.Close()

	store := newMemStore()
	svc := NewService(store)
	svc.deviceURL = server.URL + "/device"
	svc.tokenURL = server.URL + "/token"
	svc.client = server.Client()

	login, err := svc.StartLogin(t.Context())
	if err != nil || login.UserCode != "ABCD-EFGH" {
		t.Fatalf("start: %+v %v", login, err)
	}
	pending, err := svc.Poll(t.Context())
	if err != nil || !pending.LoginPending || pending.Connected {
		t.Fatalf("pending: %+v %v", pending, err)
	}
	raw, err := store.Get(t.Context(), CredentialsKey)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(publicFromRaw(t, raw), "device-secret") {
		t.Fatal("status exposed the device code")
	}
	if err := store.UpdateValueAtomic(t.Context(), CredentialsKey, func(raw string) (string, error) {
		c, err := decode(raw)
		if err != nil {
			return "", err
		}
		c.DeviceCode = ""
		c.UserCode = ""
		c.VerificationURI = ""
		c.RefreshToken = "refresh-1"
		c.AccessToken = "stale"
		c.Expiry = time.Now().Add(-time.Hour)
		return string(mustJSON(t, c)), nil
	}); err != nil {
		t.Fatal(err)
	}
	token, err := svc.bearerToken(t.Context())
	if err != nil || token != "refreshed" || tokenCalls != 1 {
		t.Fatalf("refresh: %s %v calls=%d", token, err, tokenCalls)
	}
	status, err := svc.Status(t.Context())
	if err != nil || !status.Connected || status.UserCode != "" {
		t.Fatalf("status: %+v %v", status, err)
	}
}

func publicFromRaw(t *testing.T, raw string) string {
	t.Helper()
	c, err := decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	buf, _ := json.Marshal(publicStatus(c))
	return string(buf)
}

func mustJSON(t *testing.T, c credentials) []byte {
	t.Helper()
	buf, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return buf
}

func TestPollStoresSessionWithoutReturningTokens(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := base64Payload(t, map[string]string{"email": "fampep@example.com"})
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "access-secret", "refresh_token": "refresh-secret", "expires_in": 3600,
			"id_token": "hdr." + header + ".sig",
		})
	}))
	defer server.Close()
	store := newMemStore()
	if err := store.UpdateValueAtomic(t.Context(), CredentialsKey, func(string) (string, error) {
		return string(mustJSON(t, credentials{
			DeviceCode: "device-secret", UserCode: "ABCD-EFGH",
			VerificationURI: "https://accounts.x.ai/oauth2/device", DeviceExpiry: time.Now().Add(time.Minute),
		})), nil
	}); err != nil {
		t.Fatal(err)
	}
	svc := NewService(store)
	svc.tokenURL = server.URL
	svc.client = server.Client()
	status, err := svc.Poll(t.Context())
	if err != nil || !status.Connected || status.Email != "fampep@example.com" || status.LoginPending {
		t.Fatalf("poll: %+v %v", status, err)
	}
	stored, err := store.Get(t.Context(), CredentialsKey)
	if err != nil || !strings.Contains(stored, "access-secret") {
		t.Fatal("session was not stored")
	}
	buf, _ := json.Marshal(status)
	if strings.Contains(string(buf), "access-secret") || strings.Contains(string(buf), "refresh-secret") || strings.Contains(string(buf), "device-secret") {
		t.Fatal("status included credentials")
	}
}

func base64Payload(t *testing.T, claims any) string {
	t.Helper()
	buf, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}
