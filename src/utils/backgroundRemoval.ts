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

export async function removeColorAt(
  imageDataUrl: string,
  x: number,
  y: number,
  tolerance: number,
): Promise<string | null> {
  const img = await loadImage(imageDataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = pixels;

  const px = Math.max(0, Math.min(canvas.width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(canvas.height - 1, Math.floor(y)));
  const target = (py * canvas.width + px) * 4;

  // Clique em área já transparente: nada a remover.
  if (data[target + 3] === 0) {
    return null;
  }

  const tr = data[target];
  const tg = data[target + 1];
  const tb = data[target + 2];
  const limit = tolerance * 4.5;

  // Preenchimento por inundação: apaga só a região contínua ligada ao pixel clicado.
  const { width, height } = canvas;
  const visited = new Uint8Array(width * height);
  const stack = [py * width + px];
  visited[py * width + px] = 1;

  while (stack.length > 0) {
    const pixel = stack.pop()!;
    const index = pixel * 4;
    const distance =
      Math.abs(data[index] - tr) + Math.abs(data[index + 1] - tg) + Math.abs(data[index + 2] - tb);
    if (data[index + 3] === 0 || distance > limit) {
      continue;
    }

    data[index + 3] = 0;

    const x0 = pixel % width;
    const y0 = (pixel - x0) / width;
    const neighbors = [
      x0 > 0 ? pixel - 1 : -1,
      x0 < width - 1 ? pixel + 1 : -1,
      y0 > 0 ? pixel - width : -1,
      y0 < height - 1 ? pixel + width : -1,
    ];
    for (const next of neighbors) {
      if (next >= 0 && !visited[next]) {
        visited[next] = 1;
        stack.push(next);
      }
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
