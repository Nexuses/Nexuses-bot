"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { NexusesLogo } from "@/components/NexusesLogo";
import type { ProjectDTO, SessionUser } from "@/types";

export function UserDashboard({
  user,
  projects,
}: {
  user: SessionUser;
  projects: ProjectDTO[];
}) {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <div className="min-h-full bg-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <NexusesLogo className="h-8 w-auto max-w-[160px]" />
            <p className="truncate text-xs text-muted">Signed in as {user.name}</p>
          </div>
          <button
            onClick={logout}
            className="rounded-full border border-line px-4 py-2 text-sm text-muted transition hover:border-sea hover:text-paper"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-12">
        <p className="text-sm uppercase tracking-[0.18em] text-sea">Your workspace</p>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Assigned projects</h1>
        <p className="mt-3 max-w-xl text-muted">
          Open a project to chat with Nexuses. Connect Attio, Brevo, Lemlist, or any other API.
        </p>

        {projects.length === 0 ? (
          <div className="mt-10 rounded-3xl border border-dashed border-line px-8 py-16 text-center text-muted">
            No projects assigned yet. Ask an admin to add you to a project.
          </div>
        ) : (
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
            <Link
              key={project._id}
              href={`/dashboard/${project._id}`}
              className="rounded-3xl border border-line bg-panel p-6 transition hover:border-sea"
            >
              <article>
                <img
                  src={project.logo}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="mb-5 h-16 w-16 rounded-2xl object-cover ring-1 ring-line"
                />
                <h2 className="font-display text-2xl tracking-tight">{project.name}</h2>
                <p className="mt-2 text-sm text-muted">
                  {project.members.length} {project.members.length === 1 ? "member" : "members"}
                </p>
                <p className="mt-4 text-sm text-sea">Open chat</p>
              </article>
            </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
