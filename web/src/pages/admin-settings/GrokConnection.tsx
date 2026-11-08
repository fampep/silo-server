import { useEffect } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  useDisconnectGrok,
  useGrokModels,
  useGrokStatus,
  usePollGrokLogin,
  useStartGrokLogin,
} from "@/hooks/queries/admin/grok";

import { SettingField } from "./SettingField";

/** Device-code sign-in for a Grok subscription, plus the plan's chat model. */
export function GrokConnection({
  model,
  onModelChange,
}: {
  model: string;
  onModelChange: (next: string) => void;
}) {
  const status = useGrokStatus();
  const start = useStartGrokLogin();
  const poll = usePollGrokLogin();
  const disconnect = useDisconnectGrok();
  const connection = status.data;
  const pending = connection?.login_pending === true;
  const models = useGrokModels(connection?.connected === true);

  useEffect(() => {
    if (!pending) return;
    const run = () =>
      poll.mutate(undefined, {
        onSuccess: (next) => {
          if (next.connected) toast.success("Grok plan connected.");
        },
      });
    run();
    const timer = window.setInterval(run, 3000);
    return () => window.clearInterval(timer);
  }, [pending, poll]);

  const listed = models.data?.models ?? [];
  const options = listed.map((item) => ({ value: item.id, label: item.id }));
  if (model && !options.some((option) => option.value === model)) {
    options.unshift({ value: model, label: model });
  }
  if (options.length === 0) {
    options.push({ value: "grok-4.7", label: "grok-4.7" });
  }

  return (
    <div className="space-y-3">
      <SettingField
        label="Model"
        type="select"
        value={model || "grok-4.7"}
        onChange={onModelChange}
        description="Grok plans serve chat only. An xAI API key is a separate provider."
        options={options}
      />
      {connection?.connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-xs">
            {connection.email ? `Signed in as ${connection.email}` : "Grok plan connected."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(undefined, {
                onSuccess: () => toast.success("Grok plan disconnected."),
                onError: (error) =>
                  toast.error(
                    error instanceof Error ? error.message : "Could not disconnect Grok.",
                  ),
              })
            }
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Button
            type="button"
            size="sm"
            disabled={start.isPending}
            onClick={() =>
              start.mutate(undefined, {
                onError: (error) =>
                  toast.error(
                    error instanceof Error ? error.message : "Could not start Grok sign-in.",
                  ),
              })
            }
          >
            Sign in with Grok
          </Button>
          {connection?.user_code ? (
            <p className="text-sm">
              Enter{" "}
              <span className="font-mono font-semibold tracking-wide">{connection.user_code}</span>{" "}
              at{" "}
              <a
                className="underline"
                href={connection.verification_uri}
                target="_blank"
                rel="noreferrer"
              >
                {connection.verification_uri}
              </a>
              . This page checks for the finished sign-in.
            </p>
          ) : null}
          {connection?.message ? (
            <p className="text-muted-foreground text-xs">{connection.message}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
