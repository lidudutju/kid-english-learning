import { useState } from "react";
import { api } from "../api.js";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-medium tracking-tight text-ink">
          <span className="mr-2 inline-block h-3.5 w-3.5 rounded-sm bg-brand-yellow" />
          小猫爱学习
        </h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          autoComplete="current-password"
          // Lets iOS offer the saved password instead of making you type 20 characters.
          name="password"
          autoFocus
          className="min-h-tap w-full rounded-lg border border-hairline-strong bg-canvas px-4 py-3 text-ink outline-none focus:border-brand-blue"
        />
        {error && <p className="text-sm text-coral-dark">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="min-h-tap w-full rounded-full bg-ink px-4 py-3 text-sm font-medium text-white active:bg-charcoal disabled:bg-hairline disabled:text-mist"
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
