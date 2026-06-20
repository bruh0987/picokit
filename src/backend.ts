import { useCallback, useEffect, useRef, useState } from "react";

export type BackendContext<TInput> = {
  input: TInput;
  req: Request;
};

export type BackendHandler<TInput = unknown, TOutput = unknown> = (
  ctx: BackendContext<TInput>,
) => TOutput | Promise<TOutput>;

export type BackendRuntimeHandler = {
  id: string;
  handler: BackendHandler;
};

export type BackendOptions<TInput> = {
  input?: TInput;
};

export type BackendState<TOutput> = {
  data: TOutput | undefined;
  loading: boolean;
  error: Error | undefined;
  refetch: () => Promise<void>;
};

export type BackendMutation<TInput, TOutput> = ((input: TInput) => Promise<TOutput>) & {
  data: TOutput | undefined;
  loading: boolean;
  error: Error | undefined;
};

export function useBackend<TInput = unknown, TOutput = unknown>(
  id: string,
  _handler?: BackendHandler<TInput, TOutput>,
  options: BackendOptions<TInput> = {},
): BackendState<TOutput> {
  const [data, setData] = useState<TOutput | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>();
  const inputRef = useRef(options.input);

  inputRef.current = options.input;

  const inputKey = JSON.stringify(options.input ?? null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);

    try {
      const input = encodeURIComponent(JSON.stringify(inputRef.current ?? null));
      const response = await fetch(`/_pico/backend/${encodeURIComponent(id)}?input=${input}`);
      const payload = (await response.json()) as { data?: TOutput; error?: string };

      if (!response.ok) {
        throw new Error(payload?.error ?? `Backend call failed: ${response.status}`);
      }

      setData(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [inputKey, load]);

  return { data, loading, error, refetch: load };
}

export function useMutationBackend<TInput = unknown, TOutput = unknown>(
  id: string,
  _handler?: BackendHandler<TInput, TOutput>,
): BackendMutation<TInput, TOutput> {
  const [data, setData] = useState<TOutput | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  const mutate = useCallback(
    async (input: TInput) => {
      setLoading(true);
      setError(undefined);

      try {
        const response = await fetch(`/_pico/backend/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input }),
        });
        const payload = (await response.json()) as { data?: TOutput; error?: string };

        if (!response.ok) {
          throw new Error(payload?.error ?? `Backend mutation failed: ${response.status}`);
        }

        setData(payload.data);
        return payload.data as TOutput;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setError(error);
        throw error;
      } finally {
        setLoading(false);
      }
    },
    [id],
  ) as BackendMutation<TInput, TOutput>;

  mutate.data = data;
  mutate.loading = loading;
  mutate.error = error;

  return mutate;
}
