import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./Checkbox";
import { Field } from "./Field";
import { TextInput } from "./TextInput";

describe("Field", () => {
  it("links the label to the control", () => {
    render(<Field label="Correo electrónico">{(p) => <TextInput {...p} type="email" />}</Field>);
    expect(screen.getByLabelText("Correo electrónico")).toHaveAttribute("type", "email");
  });

  it("describes the control with the hint and leaves aria-invalid off when there is no error", () => {
    render(
      <Field label="Correo electrónico" hint="Te enviaremos un enlace para entrar.">
        {(p) => <TextInput {...p} />}
      </Field>
    );
    const input = screen.getByLabelText("Correo electrónico");
    expect(input).toHaveAccessibleDescription("Te enviaremos un enlace para entrar.");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("sets aria-invalid and appends the error to aria-describedby when an error is shown", () => {
    render(
      <Field label="Correo electrónico" hint="Usa el correo de tu invitación." error="Escribe un correo válido, por ejemplo nombre@correo.com.">
        {(p) => <TextInput {...p} />}
      </Field>
    );
    const input = screen.getByLabelText("Correo electrónico");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toHaveLength(2);
    expect(input).toHaveAccessibleDescription(/Usa el correo de tu invitación\..*Escribe un correo válido/);
  });

  it("marks required controls as required", () => {
    render(
      <Field label="Contraseña" required>
        {(p) => <TextInput {...p} type="password" />}
      </Field>
    );
    expect(screen.getByLabelText("Contraseña")).toBeRequired();
  });

  it("shows the optional suffix only when asked", () => {
    render(
      <Field label="Teléfono" showOptional>
        {(p) => <TextInput {...p} />}
      </Field>
    );
    expect(screen.getByText("(opcional)")).toBeInTheDocument();
  });
});

describe("Checkbox", () => {
  it("wires hint and error the same way", () => {
    render(<Checkbox label="Mostrar mi teléfono" hint="Solo para la familia" error="Requerido" />);
    const box = screen.getByRole("checkbox", { name: "Mostrar mi teléfono" });
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toHaveAccessibleDescription("Solo para la familia Requerido");
  });
});
