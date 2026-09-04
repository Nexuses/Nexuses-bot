export type Role = "admin" | "user";

export type SessionUser = {
  userId: string;
  name: string;
  email: string;
  role: Role;
};

export type UserDTO = {
  _id: string;
  name: string;
  email: string;
  createdAt: string;
};

export type ProjectMember = {
  _id: string;
  name: string;
  email: string;
};

export type ProjectDTO = {
  _id: string;
  name: string;
  logo: string;
  members: ProjectMember[];
  createdAt: string;
};
