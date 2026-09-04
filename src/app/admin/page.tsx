"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthLayout, Field, PrimaryButton } from "@/components/ui";
import { BrandMark } from "@/components/BrandMark";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const res = await fetch("/api/auth/admin/login", {
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
    router.push("/admin/dashboard");
    router.refresh();
  }

  return (
    <AuthLayout
      variant="admin"
      eyebrow="Admin portal"
      title="Create projects. Assign people."
      subtitle="Sign in to add project logos, invite users, and control who sees what."
    >
      <div className="mb-10 flex items-center gap-3 text-brass lg:hidden">
        <BrandMark />
        <span className="font-display text-2xl">Nexuses</span>
      </div>
      <h2 className="font-display text-3xl tracking-tight">Admin sign in</h2>
      <p className="mt-2 text-muted">Use your admin account</p>
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
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </PrimaryButton>
      </form>
      <p className="mt-6 text-sm text-muted">
        Need an admin account?{" "}
        <Link href="/admin/signup" className="text-brass hover:text-brass-2">
          Sign up
        </Link>
      </p>
      <p className="mt-2 text-sm text-muted">
        User login lives at{" "}
        <Link href="/" className="text-sea hover:text-sea-2">
          /
        </Link>
      </p>
    </AuthLayout>
  );
}
