import { supabase } from "./supabase";

export interface InvokeResult<T = any> {
  /** Parsed response body, on success AND on a 4xx/5xx. Null only if unreadable. */
  data: T | null;
  /** Human-readable message, already unwrapped from the error body. */
  error: string | null;
}

/**
 * supabase-js resolves any non-2xx Edge Function response into a
 * FunctionsHttpError with `data: null`, so the JSON body — where our functions
 * put their `error` string and fields like `wait_remaining_mins` — is only
 * reachable through `error.context`, the raw Response. Read it plainly and
 * every gate the server enforces surfaces to the user as the sentence the
 * server wrote, instead of "Edge Function returned a non-2xx status code".
 */
export async function invokeFunction<T = any>(
  name: string,
  body: Record<string, unknown>,
  fallback = "Something went wrong. Please try again.",
): Promise<InvokeResult<T>> {
  const { data, error } = await supabase.functions.invoke(name, { body });

  if (!error) {
    // A 200 can still carry an { error } body from a soft failure.
    return { data: data ?? null, error: (data as any)?.error ?? null };
  }

  const res: Response | undefined = (error as any)?.context;
  if (res && typeof res.json === "function") {
    try {
      const parsed = await res.json();
      return { data: parsed ?? null, error: parsed?.error ?? error.message ?? fallback };
    } catch {
      // Non-JSON body (a gateway/timeout page) — nothing better than the throw.
    }
  }
  return { data: null, error: error.message ?? fallback };
}
