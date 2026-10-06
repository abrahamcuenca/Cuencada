import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, errorBody } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { env } from "../../../shared/lib/env";
import { FakeXhr } from "../../gallery/testUtils";
import {
  AVATAR_BUCKET_ORIGIN,
  AVATAR_PUT_URL,
  type FakeProfileDb,
  fileOf,
  makeProfile,
  makeProfileDb,
  profileHandlers
} from "../testUtils";

const server = createTestServer();
let db: FakeProfileDb;
let objectUrls: string[];
const createObjectURL = vi.fn((_blob: Blob): string => {
  const url = `blob:http://localhost/preview-${objectUrls.length + 1}`;
  objectUrls.push(url);
  return url;
});
const revokeObjectURL = vi.fn((_url: string): void => {});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeProfileDb();
  server.use(...profileHandlers(db));
  objectUrls = [];
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  env.mediaUploadOrigin = AVATAR_BUCKET_ORIGIN;
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
  env.mediaUploadOrigin = null;
});

async function openProfile(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderApp("/perfil", authenticatedState());
  await screen.findByRole("heading", { name: "Mi perfil", level: 1 });
  await screen.findByLabelText(/Nombre completo/);
  return user;
}

async function waitForXhr(): Promise<FakeXhr> {
  await waitFor(() => expect(FakeXhr.instances.length).toBe(1));
  const xhr = FakeXhr.instances[0];
  if (!xhr) throw new Error("missing XHR");
  return xhr;
}

describe("ProfilePage form", () => {
  it("loads the profile into the form with the right input types", async () => {
    await openProfile();

    expect(screen.getByLabelText(/Nombre completo/)).toHaveValue("Rosa Elena Cuenca");
    expect(screen.getByLabelText(/Cómo te dicen/)).toHaveValue("Rosa");
    expect(screen.getByLabelText(/Ciudad/)).toHaveAttribute("autocomplete", "address-level2");
    const phone = screen.getByLabelText(/Teléfono \/ WhatsApp/);
    expect(phone).toHaveAttribute("type", "tel");
    expect(phone).toHaveAttribute("inputmode", "tel");
    expect(phone).toHaveAttribute("autocomplete", "tel");
    expect(screen.getByRole("form", { name: "Datos de perfil" })).toHaveAttribute("novalidate");
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
    expect(screen.getByRole("link", { name: /Sesiones y seguridad/ })).toHaveAttribute("href", "/perfil/sesiones");
  });

  it("sends only the changed fields and shows the success toast", async () => {
    const user = await openProfile();

    const city = screen.getByLabelText(/Ciudad/);
    await user.clear(city);
    await user.type(city, "Monterrey");
    await user.type(screen.getByLabelText(/Teléfono/), "+52 999 123 4567");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText("Cambios guardados.")).toBeInTheDocument();
    expect(db.patches).toEqual([{ city: "Monterrey", phone: "+52 999 123 4567" }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled());
    expect(screen.getByLabelText(/Ciudad/)).toHaveValue("Monterrey");
  });

  it("sends null when an optional field is cleared, and nothing for a field typed back to its value", async () => {
    const user = await openProfile();

    await user.clear(screen.getByLabelText(/Rama familiar/));
    const nickname = screen.getByLabelText(/Cómo te dicen/);
    await user.type(nickname, "x");
    await user.type(nickname, "{Backspace}");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await screen.findByText("Cambios guardados.");
    expect(db.patches).toEqual([{ familyBranch: null }]);
  });

  it("validates the dirty fields with Spanish errors and sends nothing", async () => {
    const user = await openProfile();

    await user.clear(screen.getByLabelText(/Nombre completo/));
    await user.type(screen.getByLabelText(/Teléfono/), "abc");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText("Este campo es obligatorio.")).toBeInTheDocument();
    expect(screen.getByText("Teléfono inválido.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Nombre completo/)).toHaveFocus();
    expect(screen.getByLabelText(/Nombre completo/)).toHaveAttribute("aria-invalid", "true");
    expect(db.patches).toEqual([]);
  });

  it("shows the server error and keeps the edits", async () => {
    db.patchStatus = 500;
    const user = await openProfile();

    await user.type(screen.getByLabelText(/Sobre mí/), "Hola familia");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText("Algo salió mal en el servidor.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Sobre mí/)).toHaveValue("Hola familia");
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeEnabled();
  });
});

describe("ProfilePage privacy", () => {
  it("sends each toggled switch with its new value", async () => {
    const user = await openProfile();

    const phone = screen.getByRole("switch", { name: "Mostrar mi teléfono a la familia" });
    const email = screen.getByRole("switch", { name: "Mostrar mi correo a la familia" });
    expect(phone).not.toBeChecked();
    expect(email).toBeChecked();
    expect(screen.getByRole("switch", { name: "Mostrar mi ciudad a la familia" })).toBeChecked();

    await user.click(phone);
    await user.click(email);
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await screen.findByText("Cambios guardados.");
    expect(db.patches).toEqual([{ showEmail: false, showPhone: true }]);
    expect(db.profile.visibility).toEqual({ showEmail: false, showPhone: true, showCity: true });
  });

  it("explains each switch in Spanish", async () => {
    await openProfile();

    expect(screen.getByRole("switch", { name: "Mostrar mi correo a la familia" })).toHaveAccessibleDescription(
      "Tu correo (prima@example.com) aparecerá en tu ficha del directorio."
    );
    expect(screen.getByText(/Tus datos solo los ve la familia con sesión iniciada/)).toBeInTheDocument();
  });

  it("hides the directory switch while the API has no listedInDirectory field", async () => {
    await openProfile();

    expect(screen.queryByRole("switch", { name: "Aparecer en el directorio" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(3);
  });

  it("shows and sends the directory switch once the API returns listedInDirectory", async () => {
    db.profile = { ...makeProfile(), visibility: { ...makeProfile().visibility, listedInDirectory: true } };
    const user = await openProfile();

    const listed = screen.getByRole("switch", { name: "Aparecer en el directorio" });
    expect(listed).toBeChecked();
    expect(listed).toHaveAccessibleDescription(/no aparecerás en el directorio ni en su búsqueda/);
    await user.click(listed);
    await user.click(screen.getByRole("switch", { name: "Mostrar mi ciudad a la familia" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await screen.findByText("Cambios guardados.");
    expect(db.patches).toEqual([{ showCity: false, listedInDirectory: false }]);
    expect(db.profile.visibility).toEqual({ showEmail: true, showPhone: false, showCity: false, listedInDirectory: false });
  });
});

describe("ProfilePage avatar", () => {
  it("previews, PUTs with only the signed headers, then confirms", async () => {
    const user = await openProfile();
    const file = fileOf("yo.jpg", "image/jpeg");

    expect(screen.getByTestId("avatar-file-input")).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    await user.upload(screen.getByTestId("avatar-file-input"), file);

    expect(createObjectURL).toHaveBeenCalledWith(file);
    const xhr = await waitForXhr();
    expect(db.intents).toEqual([{ mimeType: "image/jpeg", byteSize: 2048 }]);
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(AVATAR_PUT_URL);
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.headers).toEqual({ "Content-Type": "image/jpeg", "x-amz-acl": "private" });
    expect(xhr.body).toBe(file);
    const preview = screen.getByRole("img", { name: "Rosa Elena Cuenca" }).querySelector("img");
    expect(preview).toHaveAttribute("src", "blob:http://localhost/preview-1");

    act(() => xhr.progress(1024, 2048));
    expect(await screen.findByText("Subiendo foto… 50 %")).toBeInTheDocument();
    act(() => xhr.respond(200));

    expect(await screen.findByText("Foto actualizada.")).toBeInTheDocument();
    expect(db.confirms).toEqual([{ uploadId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/preview-1");
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Rosa Elena Cuenca" }).querySelector("img")).toHaveAttribute(
        "src",
        "https://bucket.example/avatars/new.webp?X-Amz-Signature=a1"
      )
    );
    expect(document.body.innerHTML).not.toContain("supersecret");
  });

  it("refuses an intent whose URL is not on the configured upload origin", async () => {
    db.uploadUrl = "https://evil.example/avatars/obj-1?X-Amz-Signature=supersecret";
    const user = await openProfile();

    await user.upload(screen.getByTestId("avatar-file-input"), fileOf("yo.png", "image/png"));

    expect(await screen.findByText("No pudimos subir la foto. Inténtalo otra vez.")).toBeInTheDocument();
    expect(FakeXhr.instances).toHaveLength(0);
    expect(db.confirms).toEqual([]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/preview-1");
    expect(document.body.innerHTML).not.toContain("evil.example");
  });

  it("refuses every upload when the upload origin is not configured", async () => {
    env.mediaUploadOrigin = null;
    const user = await openProfile();

    await user.upload(screen.getByTestId("avatar-file-input"), fileOf("yo.webp", "image/webp"));

    expect(await screen.findByText("No pudimos subir la foto. Inténtalo otra vez.")).toBeInTheDocument();
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("checks type and size before sending anything", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderApp("/perfil", authenticatedState());
    await screen.findByLabelText(/Nombre completo/);

    await user.upload(screen.getByTestId("avatar-file-input"), fileOf("yo.heic", "image/heic"));
    expect(await screen.findByText("La foto debe ser JPG, PNG o WebP.")).toBeInTheDocument();

    await user.upload(screen.getByTestId("avatar-file-input"), fileOf("grande.jpg", "image/jpeg", 11 * 1024 * 1024));
    expect(await screen.findByText("La foto supera el máximo de 10 MB.")).toBeInTheDocument();

    expect(db.intents).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("shows the failure and drops the preview when the bucket refuses the PUT", async () => {
    const user = await openProfile();

    await user.upload(screen.getByTestId("avatar-file-input"), fileOf("yo.jpg", "image/jpeg"));
    const xhr = await waitForXhr();
    act(() => xhr.respond(403));

    expect(await screen.findByText("No pudimos subir la foto. Inténtalo otra vez.")).toBeInTheDocument();
    expect(db.confirms).toEqual([]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/preview-1");
    expect(screen.getByRole("img", { name: "Rosa Elena Cuenca" }).querySelector("img")).toBeNull();
  });

  it("revokes the preview and aborts the upload when the page unmounts", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/perfil", authenticatedState());
    await screen.findByLabelText(/Nombre completo/);

    await user.upload(screen.getByTestId("avatar-file-input"), fileOf("yo.jpg", "image/jpeg"));
    const xhr = await waitForXhr();
    await act(async () => {
      await router.navigate("/mas");
    });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/preview-1");
    expect(xhr.aborted).toBe(true);
    expect(db.confirms).toEqual([]);
  });
});

describe("ProfilePage states", () => {
  it("refetches the profile once when the avatar URL has expired", async () => {
    db.profile = makeProfile({ avatarUrl: "https://bucket.example/avatars/old.webp?X-Amz-Signature=old" });
    let gets = 0;
    server.use(
      http.get(apiUrl("/profile/me"), () => {
        gets += 1;
        return HttpResponse.json(db.profile);
      })
    );
    await openProfile();

    const img = screen.getByRole("img", { name: "Rosa Elena Cuenca" }).querySelector("img");
    if (!img) throw new Error("missing avatar image");
    expect(gets).toBe(1);
    fireEvent.error(img);
    await waitFor(() => expect(gets).toBe(2));
  });

  it("offers a retry when the profile can't load", async () => {
    let failures = 1;
    server.use(
      http.get(apiUrl("/profile/me"), () => {
        if (failures === 0) return HttpResponse.json(db.profile);
        failures -= 1;
        return HttpResponse.json(errorBody("INTERNAL"), { status: 500 });
      })
    );
    const user = userEvent.setup();
    renderApp("/perfil", authenticatedState());

    expect(await screen.findByText("No pudimos cargar tu perfil")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByLabelText(/Nombre completo/)).toHaveValue("Rosa Elena Cuenca");
  });
});
