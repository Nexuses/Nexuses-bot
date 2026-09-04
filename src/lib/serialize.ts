import type { ProjectDTO, UserDTO } from "@/types";

type LeanUser = {
  _id: unknown;
  name: string;
  email: string;
  createdAt?: Date;
};

type LeanMember = {
  _id: unknown;
  name: string;
  email: string;
};

type LeanProject = {
  _id: unknown;
  name: string;
  logo: string;
  members?: LeanMember[];
  createdAt?: Date;
};

export function serializeUser(user: LeanUser): UserDTO {
  return {
    _id: String(user._id),
    name: user.name,
    email: user.email,
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : "",
  };
}

export function serializeProject(project: LeanProject): ProjectDTO {
  return {
    _id: String(project._id),
    name: project.name,
    logo: project.logo,
    members: (project.members ?? []).map((member) => ({
      _id: String(member._id),
      name: member.name,
      email: member.email,
    })),
    createdAt: project.createdAt ? new Date(project.createdAt).toISOString() : "",
  };
}
