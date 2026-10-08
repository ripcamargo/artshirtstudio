export async function removeSolidBackground(imageDataUrl: string, tolerance: number): Promise<string> {
  const img = await loadImage(imageDataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return imageDataUrl;
  }

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = pixels;

  const edgeSamples = [
    [0, 0],
    [canvas.width - 1, 0],
    [0, canvas.height - 1],
    [canvas.width - 1, canvas.height - 1],
    [Math.floor(canvas.width / 2), 0],
    [0, Math.floor(canvas.height / 2)],
    [canvas.width - 1, Math.floor(canvas.height / 2)],
    [Math.floor(canvas.width / 2), canvas.height - 1],
  ].map(([x, y]) => {
    const idx = (y * canvas.width + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2]] as const;
  });

  const bg = edgeSamples.reduce(
    (acc, [r, g, b]) => [acc[0] + r, acc[1] + g, acc[2] + b] as [number, number, number],
    [0, 0, 0] as [number, number, number],
  );

  const [br, bgColorG, bgColorB] = bg.map((value) => value / edgeSamples.length) as [number, number, number];
  const limit = tolerance * 4.5;

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const alpha = data[index + 3];

    const distance = Math.abs(r - br) + Math.abs(g - bgColorG) + Math.abs(b - bgColorB);
    if (alpha > 0 && distance <= limit) {
      data[index + 3] = 0;
    }
  }

  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load image'));
    image.src = src;
  });
}
