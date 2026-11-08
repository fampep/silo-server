package llm

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestGrokPlanStaysOnSubscriptionProxy(t *testing.T) {
	client := NewClient(Config{
		AuthMode:  AuthModeGrok,
		ChatModel: "grok-4.7",
		BaseURL:   "https://evil.example.test",
		APIKey:    "sk-should-not-be-sent",
		GrokTokenSource: testTokenSource(func(context.Context) (string, error) {
			return "plan-token", nil
		}),
	})
	client.chatHTTP.Transport = retryRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != grokResponsesURL {
			t.Fatalf("plan request went to %s", r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer plan-token" {
			t.Fatal("missing plan token")
		}
		if r.Header.Get("X-XAI-Token-Auth") != "xai-grok-cli" || r.Header.Get("x-grok-client-version") != GrokClientVersion {
			t.Fatal("missing Grok CLI identity")
		}
		if r.Header.Get("User-Agent") != "xai-grok-workspace/"+GrokClientVersion {
			t.Fatal("missing Grok CLI user agent")
		}
		if r.Header.Get("x-grok-model-override") != "grok-4.7" {
			t.Fatal("missing model override")
		}
		if strings.Contains(r.Header.Get("Authorization"), "sk-should-not-be-sent") {
			t.Fatal("API key was sent with the plan")
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body: io.NopCloser(strings.NewReader(
				"data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\ndata: {\"type\":\"response.completed\"}\n\n",
			)),
		}, nil
	})
	got, err := client.Chat(t.Context(), []Message{{Role: "user", Content: "hi"}}, false)
	if err != nil || got != "ok" {
		t.Fatalf("chat = %q, %v", got, err)
	}
}
