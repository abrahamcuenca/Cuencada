import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4"]);

export async function registerGalleryRoutes(app: FastifyInstance): Promise<void> {
  app.post("/cuencadas/:year/gallery/upload-url", async (request, reply) => {
    const user = await app.auth.requireUser(request, reply);
    if (!user) return;

    const params = z.object({ year: z.coerce.number().int() }).parse(request.params);
    const body = z.object({ fileName: z.string().min(1), mimeType: z.string().min(1), byteSize: z.number().int().positive().max(100 * 1024 * 1024) }).parse(request.body);

    if (!allowedMimeTypes.has(body.mimeType)) {
      return reply.code(400).send({ error: "Tipo de archivo no permitido." });
    }
    if (!app.config.S3_BUCKET || !app.config.S3_ENDPOINT || !app.config.S3_ACCESS_KEY_ID || !app.config.S3_SECRET_ACCESS_KEY) {
      return reply.code(503).send({ error: "El almacenamiento de fotos todavía no está configurado." });
    }

    const safeName = body.fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
    const objectKey = `cuencadas/${params.year}/gallery/${crypto.randomUUID()}-${safeName}`;
    const client = new S3Client({
      endpoint: app.config.S3_ENDPOINT,
      region: app.config.S3_REGION,
      credentials: { accessKeyId: app.config.S3_ACCESS_KEY_ID, secretAccessKey: app.config.S3_SECRET_ACCESS_KEY },
      forcePathStyle: false
    });
    const uploadUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: app.config.S3_BUCKET, Key: objectKey, ContentType: body.mimeType }), { expiresIn: 300 });

    return reply.send({ objectKey, uploadUrl });
  });
}
