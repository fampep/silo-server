package apiv2

import (
	"context"
	"errors"

	"github.com/Silo-Server/silo-server/internal/ai/grok"
)

// GrokService is the Grok plan connection shown in AI Services.
type GrokService interface {
	Status(context.Context) (grok.Status, error)
	StartLogin(context.Context) (grok.Login, error)
	Poll(context.Context) (grok.Status, error)
	Disconnect(context.Context) (grok.Status, error)
	Models(context.Context) ([]grok.Model, error)
}

type GrokStatus grok.Status
type GrokLogin grok.Login

type GrokStatusOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         GrokStatus
}

type GrokLoginOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         GrokLogin
}

type GrokModelsOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         struct {
		Models []grok.Model `json:"models"`
	}
}

func grokProblem(err error) error {
	switch {
	case errors.Is(err, grok.ErrSignInRequired):
		return NewProblem(TypeCapabilityNotConfigured, grok.ErrSignInRequired.Error())
	default:
		return NewProblem(TypeInternalError, "The Grok plan connection could not be confirmed. Refresh the connection and try again.")
	}
}

func registerGrok(reg *Registry) {
	op := func(method, path, id, summary string) Operation {
		o := Operation{Operation: humaOp(method, Prefix+path, id, "admin-ai", summary), Class: ClassActingAdmin, ServiceBacked: true}
		if isMutatingMethod(method) {
			o.RetrySafety = RetrySafetyNonRetryable
			o.DemoRestricted = true
		}
		return o
	}
	require := func() error {
		if reg.deps.Grok == nil {
			return unavailable("Grok plan connection")
		}
		return nil
	}
	Register(reg, op("GET", "/admin/ai/grok", "getAdminGrokConnection", "Read Grok plan connection status without credentials."), func(ctx context.Context, _ *struct{}) (*GrokStatusOutput, error) {
		if err := require(); err != nil {
			return nil, err
		}
		status, err := reg.deps.Grok.Status(ctx)
		if err != nil {
			return nil, grokProblem(err)
		}
		return &GrokStatusOutput{CacheControl: chatGPTCacheControl, Body: GrokStatus(status)}, nil
	})
	Register(reg, op("POST", "/admin/ai/grok/login", "startAdminGrokLogin", "Start a Grok device-code sign-in. The administrator opens the verification URL and enters the code."), func(ctx context.Context, _ *struct{}) (*GrokLoginOutput, error) {
		if err := require(); err != nil {
			return nil, err
		}
		login, err := reg.deps.Grok.StartLogin(ctx)
		if err != nil {
			return nil, grokProblem(err)
		}
		return &GrokLoginOutput{CacheControl: chatGPTCacheControl, Body: GrokLogin(login)}, nil
	})
	Register(reg, op("POST", "/admin/ai/grok/login/poll", "pollAdminGrokLogin", "Check once whether the pending Grok device-code sign-in has finished."), func(ctx context.Context, _ *struct{}) (*GrokStatusOutput, error) {
		if err := require(); err != nil {
			return nil, err
		}
		status, err := reg.deps.Grok.Poll(ctx)
		if err != nil {
			return nil, grokProblem(err)
		}
		return &GrokStatusOutput{CacheControl: chatGPTCacheControl, Body: GrokStatus(status)}, nil
	})
	Register(reg, op("DELETE", "/admin/ai/grok", "disconnectAdminGrok", "Forget the saved Grok plan session."), func(ctx context.Context, _ *struct{}) (*GrokStatusOutput, error) {
		if err := require(); err != nil {
			return nil, err
		}
		status, err := reg.deps.Grok.Disconnect(ctx)
		if err != nil {
			return nil, grokProblem(err)
		}
		return &GrokStatusOutput{CacheControl: chatGPTCacheControl, Body: GrokStatus(status)}, nil
	})
	Register(reg, op("GET", "/admin/ai/grok/models", "listAdminGrokModels", "List chat models for the connected Grok plan."), func(ctx context.Context, _ *struct{}) (*GrokModelsOutput, error) {
		if err := require(); err != nil {
			return nil, err
		}
		models, err := reg.deps.Grok.Models(ctx)
		if err != nil {
			return nil, grokProblem(err)
		}
		out := &GrokModelsOutput{CacheControl: chatGPTCacheControl}
		out.Body.Models = models
		return out, nil
	})
}
