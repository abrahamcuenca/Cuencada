import type { ReactNode } from "react";

/** `/chat/:roomId?`: placeholder until T7 builds the real page. */
export function ChatPage(): ReactNode {
  return (
    <section className="shell">
      <p className="kicker">Solo miembros</p>
      <h1>Chat familiar</h1>
      <p>Salas de conversación de la familia.</p>
    </section>
  );
}
