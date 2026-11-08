package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// chatGrok sends a plan session to the Grok CLI chat proxy. The token is never
// sent to an administrator-configured base URL.
func (c *Client) chatGrok(ctx context.Context, cfg Config, messages []Message, jsonObject bool) (string, error) {
	if cfg.GrokTokenSource == nil {
		return "", errors.New("connect a Grok account in AI Services")
	}
	tokenSource, err := cfg.GrokTokenSource(ctx)
	if err != nil {
		return "", err
	}
	input := make([]Message, len(messages))
	for i, message := range messages {
		if message.Role == "system" {
			message.Role = "developer"
		}
		input[i] = message
	}
	req := responseRequest{Model: cfg.ChatModel, Input: input, Store: false, Stream: true}
	if cfg.ReasoningEffort != "" {
		req.Reasoning = &responseReasoning{Effort: cfg.ReasoningEffort}
	}
	if jsonObject {
		req.Text = &responseTextFormat{Format: chatResponseFormat{Type: chatJSONFormat}}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	var content string
	httpClient := *c.chatHTTP
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	var requestToken string
	for attempt := range 2 {
		err = c.doReaderWithRetry(ctx, &httpClient, "Grok plan",
			func() (*http.Request, error) {
				token, tokenErr := tokenSource(ctx)
				if tokenErr != nil {
					return nil, tokenErr
				}
				requestToken = token
				httpReq, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, grokResponsesURL, bytes.NewReader(body))
				if reqErr != nil {
					return nil, reqErr
				}
				httpReq.Header.Set("Content-Type", "application/json")
				httpReq.Header.Set("Accept", "text/event-stream")
				httpReq.Header.Set("Authorization", "Bearer "+token)
				httpReq.Header.Set("X-XAI-Token-Auth", "xai-grok-cli")
				httpReq.Header.Set("x-grok-client-version", GrokClientVersion)
				httpReq.Header.Set("User-Agent", "xai-grok-workspace/"+GrokClientVersion)
				if cfg.ChatModel != "" {
					httpReq.Header.Set("x-grok-model-override", cfg.ChatModel)
				}
				return httpReq, nil
			}, func(data io.Reader) error {
				var parseErr error
				content, parseErr = readResponseStream(data)
				return parseErr
			})
		unauthorized, _ := errors.AsType[*HTTPError](err)
		if unauthorized == nil || unauthorized.StatusCode != http.StatusUnauthorized || cfg.GrokTokenRejected == nil {
			break
		}
		if rejectErr := cfg.GrokTokenRejected(ctx, requestToken, attempt == 1); rejectErr != nil {
			return "", rejectErr
		}
	}
	return content, err
}
