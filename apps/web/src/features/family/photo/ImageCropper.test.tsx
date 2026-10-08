import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageDecodeError } from "../../gallery/lib/resizeCore";
import { CROPPER_DECODE_ERROR, ImageCropper } from "./ImageCropper";

const decodeForPreview = vi.hoisted(() => vi.fn());
const cropImageToSquare = vi.hoisted(() => vi.fn());
vi.mock("../../gallery/lib/resizeImage", () => ({ decodeForPreview, cropImageToSquare }));

/** A decoded 400 × 200 preview. */
function bitmap(): ImageBitmap {
  return { width: 400, height: 200, close: vi.fn() } as unknown as ImageBitmap; // Safe: the component only reads width/height and calls close.
}

const picked = new File([new Uint8Array([0xff, 0xd8, 0xff])], "foto.jpg", { type: "image/jpeg" });

beforeEach(() => {
  decodeForPreview.mockReset();
  cropImageToSquare.mockReset();
  // jsdom has no 2D canvas: painting is skipped (the component handles a null context).
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("ImageCropper", () => {
  it("shows the Spanish controls and saves the framed square through the resize pipeline", async () => {
    const preview = bitmap();
    decodeForPreview.mockResolvedValue(preview);
    const result = new File([new Uint8Array([1])], "foto.jpg", { type: "image/jpeg" });
    cropImageToSquare.mockResolvedValue(result);
    const onCropped = vi.fn();
    const user = userEvent.setup();
    render(<ImageCropper file={picked} onCancel={vi.fn()} onCropped={onCropped} />);

    expect(screen.getByRole("heading", { name: "Ajustar foto" })).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Guardar" });
    await waitFor(() => expect(save).toBeEnabled());
    expect(decodeForPreview).toHaveBeenCalledWith(picked, 2048);
    for (const name of ["Acercar", "Alejar", "Girar", "Cancelar"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Acercar" }));
    await user.click(screen.getByRole("button", { name: "Girar" }));
    await user.click(save);

    await waitFor(() => expect(onCropped).toHaveBeenCalledWith(result));
    const [file, spec] = cropImageToSquare.mock.calls[0] ?? [];
    expect(file).toBe(picked);
    // Zoom 1.25 after a quarter turn of a 400 × 200 image: 160 px square, centred in the 200 × 400 rotated image.
    expect(spec.rotation).toBe(90);
    expect(spec.width).toBeCloseTo(160 / 200);
    expect(spec.height).toBeCloseTo(160 / 400);
    expect(spec.x).toBeCloseTo(20 / 200);
    expect(spec.y).toBeCloseTo(120 / 400);
  });

  it("moves with the arrow keys and zooms with + and −, in bounds", async () => {
    decodeForPreview.mockResolvedValue(bitmap());
    cropImageToSquare.mockResolvedValue(picked);
    render(<ImageCropper file={picked} onCancel={vi.fn()} onCropped={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Guardar" })).toBeEnabled());
    const canvas = screen.getByTestId("image-cropper-canvas");
    const slider = screen.getByRole("slider", { name: "Zoom" });

    fireEvent.keyDown(canvas, { key: "+" });
    expect(slider).toHaveValue("1.25");
    fireEvent.keyDown(canvas, { key: "-" });
    fireEvent.keyDown(canvas, { key: "-" });
    expect(slider).toHaveValue("1");
    expect(screen.getByRole("button", { name: "Alejar" })).toBeDisabled();
    for (let index = 0; index < 50; index += 1) fireEvent.keyDown(canvas, { key: "ArrowRight", shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(cropImageToSquare).toHaveBeenCalled());
    // Panned as far right as possible: the left half of the landscape image.
    expect(cropImageToSquare.mock.calls[0]?.[1].x).toBeCloseTo(0);
  });

  it("explains an undecodable photo and keeps Guardar disabled", async () => {
    decodeForPreview.mockRejectedValue(new ImageDecodeError());
    render(<ImageCropper file={picked} onCancel={vi.fn()} onCropped={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(CROPPER_DECODE_ERROR);
    expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled();
  });

  it("frees the decoded preview when it closes", async () => {
    const preview = bitmap();
    decodeForPreview.mockResolvedValue(preview);
    const onCancel = vi.fn();
    const { unmount } = render(<ImageCropper file={picked} onCancel={onCancel} onCropped={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Guardar" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancel).toHaveBeenCalled();
    unmount();
    expect(preview.close).toHaveBeenCalled();
  });
});
