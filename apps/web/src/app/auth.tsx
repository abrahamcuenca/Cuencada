import type { CurrentUser } from "@cuencada/types";
import { createContext, type PropsWithChildren, useContext, useEffect, useState } from "react";

interface AuthState {
  user: CurrentUser | null;
  accessToken: string | null;
  status: "loading" | "authenticated" | "anonymous";
  loginAsDemoAdmin: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const demoAdmin: CurrentUser = {
  id: "demo-admin",
  email: "admin@cuencada.com",
  displayName: "Administrador Cuencada",
  role: "admin",
  mustChangePassword: true
};

export function AuthProvider({ children }: PropsWithChildren): React.ReactNode {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("loading");

  useEffect(() => {
    const stored = window.localStorage.getItem("cuencada-demo-user");
    if (stored) {
      setUser(JSON.parse(stored) as CurrentUser);
      setAccessToken("demo-token");
      setStatus("authenticated");
      return;
    }
    setStatus("anonymous");
  }, []);

  function loginAsDemoAdmin(): void {
    window.localStorage.setItem("cuencada-demo-user", JSON.stringify(demoAdmin));
    setUser(demoAdmin);
    setAccessToken("demo-token");
    setStatus("authenticated");
  }

  function logout(): void {
    window.localStorage.removeItem("cuencada-demo-user");
    setUser(null);
    setAccessToken(null);
    setStatus("anonymous");
  }

  return <AuthContext.Provider value={{ user, accessToken, status, loginAsDemoAdmin, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth debe usarse dentro de AuthProvider.");
  return auth;
}
