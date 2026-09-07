"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { NexusesLogo } from "@/components/NexusesLogo";

export function Field({
  label,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted">{label}</span>
      <input
        className={`w-full rounded-xl border border-line bg-ink-2 px-4 py-3 text-paper outline-none transition placeholder:text-muted/60 focus:border-brass ${className}`}
        {...props}
      />
    </label>
  );
}

export function PrimaryButton({
  children,
  className = "",
  tone = "brass",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "brass" | "sea" }) {
  const colors =
    tone === "sea"
      ? "bg-sea text-on-sea hover:bg-sea-2"
      : "bg-brass text-on-brass hover:bg-brass-2";
  return (
    <button
      className={`inline-flex h-12 w-full items-center justify-center rounded-xl px-5 text-sm font-semibold tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50 ${colors} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function AuthLayout({
  variant,
  eyebrow,
  title,
  subtitle,
  children,
}: {
  variant: "admin" | "user";
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  const accent = variant === "admin" ? "text-brass" : "text-sea";

  return (
    <div className="grid min-h-full flex-1 lg:grid-cols-[1.05fr_0.95fr]">
      <section className="relative hidden h-full min-h-full overflow-hidden border-r border-line bg-ink-2 lg:flex lg:flex-col">
        <div className="pointer-events-none absolute inset-0 opacity-50">
          <svg className="h-full w-full" viewBox="0 0 800 900" fill="none" aria-hidden>
            <g stroke="currentColor" className={accent} strokeOpacity="0.28">
              <circle cx="220" cy="180" r="120" />
              <circle cx="520" cy="430" r="180" />
              <circle cx="260" cy="680" r="90" />
              <path d="M220 180L520 430L260 680L220 180" />
            </g>
            <g fill="currentColor" className={accent}>
              <circle cx="220" cy="180" r="6" />
              <circle cx="520" cy="430" r="6" />
              <circle cx="260" cy="680" r="6" />
            </g>
          </svg>
        </div>
        <div className="relative z-10 flex min-h-full flex-1 flex-col justify-between p-12">
          <NexusesLogo className="h-14 w-auto max-w-[280px]" />
          <div className="max-w-md">
            <p className={`mb-3 text-sm font-medium uppercase tracking-[0.22em] ${accent}`}>
              {eyebrow}
            </p>
            <h1 className="font-display text-5xl leading-[1.05] tracking-tight text-paper">
              {title}
            </h1>
            <p className="mt-5 text-lg leading-8 text-muted">{subtitle}</p>
          </div>
          <p className="text-sm text-muted">Projects, people, and access in one place.</p>
        </div>
      </section>
      <section className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">
          <div className="mb-10 lg:hidden">
            <NexusesLogo className="h-14 w-auto max-w-[280px]" />
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}
