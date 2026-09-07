"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthLayout, Field, PrimaryButton } from "@/components/ui";

export default function UserLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const res = await fetch("/api/auth/user/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not sign in");
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <AuthLayout
      variant="user"
      eyebrow="User portal"
      title="Sign in to your projects."
      subtitle="Use the account your admin created. Once assigned, your projects appear here."
    >
      <h2 className="font-display text-3xl tracking-tight">Welcome back</h2>
      <p className="mt-2 text-muted">User login</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {error ? <p className="text-sm text-red-500">{error}</p> : null}
        <PrimaryButton type="submit" tone="sea" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </PrimaryButton>
      </form>
      <p className="mt-6 text-sm text-muted">
        Admin?{" "}
        <Link href="/admin" className="text-brass hover:text-brass-2">
          Open admin portal
        </Link>
      </p>
    </AuthLayout>
  );
}
