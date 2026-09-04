"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthLayout, Field, PrimaryButton } from "@/components/ui";
import { BrandMark } from "@/components/BrandMark";

export default function AdminSignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const res = await fetch("/api/auth/admin/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not create account");
      return;
    }
    router.push("/admin/dashboard");
    router.refresh();
  }

  return (
    <AuthLayout
      variant="admin"
      eyebrow="Admin portal"
      title="Set up the control room."
      subtitle="Create an admin account, then add projects and assign users to them."
    >
      <div className="mb-10 flex items-center gap-3 text-brass lg:hidden">
        <BrandMark />
        <span className="font-display text-2xl">Nexuses</span>
      </div>
      <h2 className="font-display text-3xl tracking-tight">Create admin</h2>
      <p className="mt-2 text-muted">This account can manage projects and people</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <Field
          label="Name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          minLength={2}
        />
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
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={8}
        />
        {error ? <p className="text-sm text-red-500">{error}</p> : null}
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Creating..." : "Create admin account"}
        </PrimaryButton>
      </form>
      <p className="mt-6 text-sm text-muted">
        Already have an admin account?{" "}
        <Link href="/admin" className="text-brass hover:text-brass-2">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
