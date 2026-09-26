import crypto from "node:crypto";
import fs from "node:fs/promises";
import sharp from "sharp";
import { config } from "../config.js";

export async function inspectImage(inputPath) {
  const metadata = await sharp(inputPath).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Image has no readable dimensions");
  }

  if (
    metadata.width < config.content.minWidth ||
    metadata.height < config.content.minHeight
  ) {
    throw new Error(
      `Image too small: ${metadata.width}x${metadata.height}`
    );
  }

  return metadata;
}

export async function processImage(inputPath) {
  const outputPath = inputPath.replace(/\.[^.]+$/, "") + "-processed.jpg";

  const pipeline = sharp(inputPath)
    .rotate()
    .resize({
      width: 2000,
      height: 2000,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({
      quality: 90,
      mozjpeg: true
    });

  await pipeline.toFile(outputPath);

  const metadata = await sharp(outputPath).metadata();

  if (metadata.size && metadata.size > config.content.maxTelegramBytes) {
    await sharp(outputPath)
      .jpeg({
        quality: 78,
        mozjpeg: true
      })
      .toFile(`${outputPath}.tmp`);

    await fs.rename(`${outputPath}.tmp`, outputPath);
  }

  return outputPath;
}

export async function sha256(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

export async function cleanupFiles(...paths) {
  for (const filePath of paths) {
    if (!filePath) continue;
    try {
      await fs.unlink(filePath);
    } catch {
      // Already removed.
    }
  }
}
