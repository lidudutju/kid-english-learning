import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, UnauthenticatedError } from "./api.js";
import { Add } from "./pages/Add.js";
import { Library } from "./pages/Library.js";
import { Login } from "./pages/Login.js";
import { Player } from "./pages/Player.js";
import { Today } from "./pages/Today.js";
import { useLibrary } from "./useLibrary.js";

type AuthState = "checking" | "in" | "out";

export function App() {
  const [auth, setAuth] = useState<AuthState>("checking");

  useEffect(() => {
    api
      .me()
      .then(() => setAuth("in"))
      .catch((err) => setAuth(err instanceof UnauthenticatedError ? "out" : "out"));
  }, []);

  if (auth === "checking") return null;
  if (auth === "out") return <Login onSuccess={() => setAuth("in")} />;

  return <SignedIn onSignedOut={() => setAuth("out")} />;
}

function SignedIn({ onSignedOut }: { onSignedOut: () => void }) {
  // The session lasts 180 days, so this fires almost never — but when it does, every page
  // needs to fall back to the login screen rather than showing an empty library.
  const handleUnauthenticated = useCallback(() => onSignedOut(), [onSignedOut]);
  const library = useLibrary(handleUnauthenticated);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Library library={library} />} />
        <Route path="/today" element={<Today library={library} />} />
        <Route path="/add" element={<Add library={library} />} />
        <Route path="/v/:id" element={<Player library={library} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
