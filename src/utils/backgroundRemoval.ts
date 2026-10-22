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

/**
 * Elimina o "serrilhado" claro que sobra em volta da arte depois de remover o fundo:
 * contrai o contorno `radius` px para dentro (descarta os pixels de borda ainda contaminados
 * pela cor do fundo) e suaviza o que restou da borda para não ficar com degraus.
 */
export async function refineEdges(imageDataUrl: string, radius: number): Promise<string> {
  const img = await loadImage(imageDataUrl);

  const canvas = document.createElement('canvas');
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return imageDataUrl;
  }

  ctx.drawImage(img, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height);
  const { data } = pixels;

  let alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < alpha.length; i += 1) {
    alpha[i] = data[i * 4 + 3];
  }

  // Contração: cada passada leva o menor alfa da vizinhança 3x3 (as bordas da imagem não contam como vazio).
  for (let pass = 0; pass < radius; pass += 1) {
    const next = new Uint8ClampedArray(alpha);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let min = alpha[y * width + x];
        for (let dy = -1; dy <= 1 && min > 0; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) {
            continue;
          }
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            if (nx >= 0 && nx < width) {
              min = Math.min(min, alpha[ny * width + nx]);
            }
          }
        }
        next[y * width + x] = min;
      }
    }
    alpha = next;
  }

  // Suavização leve só na faixa da borda (pixels que não são totalmente opacos nem têm vizinho transparente).
  const smoothed = new Uint8ClampedArray(alpha);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const left = x > 0 ? alpha[index - 1] : alpha[index];
      const right = x < width - 1 ? alpha[index + 1] : alpha[index];
      const up = y > 0 ? alpha[index - width] : alpha[index];
      const down = y < height - 1 ? alpha[index + width] : alpha[index];
      if (alpha[index] === 255 && left === 255 && right === 255 && up === 255 && down === 255) {
        continue;
      }
      if (alpha[index] === 0 && left === 0 && right === 0 && up === 0 && down === 0) {
        continue;
      }

      smoothed[index] = (alpha[index] * 4 + left + right + up + down) / 8;
    }
  }

  for (let i = 0; i < smoothed.length; i += 1) {
    data[i * 4 + 3] = smoothed[i];
  }

  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

const INF = 1e20;

/** Distância euclidiana ao quadrado de cada pixel até o pixel "feature" mais próximo (Felzenszwalb, O(n)). */
function squaredDistanceTransform(width: number, height: number, isFeature: Uint8Array) {
  const size = Math.max(width, height);
  const grid = new Float32Array(width * height);
  for (let i = 0; i < grid.length; i += 1) {
    grid[i] = isFeature[i] ? 0 : INF;
  }

  const f = new Float32Array(size);
  const d = new Float32Array(size);
  const v = new Int32Array(size);
  const z = new Float32Array(size + 1);

  const transform1d = (n: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q += 1) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k -= 1;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }

    k = 0;
    for (let q = 0; q < n; q += 1) {
      while (z[k + 1] < q) {
        k += 1;
      }
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      f[y] = grid[y * width + x];
    }
    transform1d(height);
    for (let y = 0; y < height; y += 1) {
      grid[y * width + x] = d[y];
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      f[x] = grid[y * width + x];
    }
    transform1d(width);
    for (let x = 0; x < width; x += 1) {
      grid[y * width + x] = d[x];
    }
  }

  return grid;
}

/**
 * Adiciona um contorno de `width` px (cor `color`, "#rrggbb") em volta da arte. A imagem cresce
 * `width` px de cada lado para caber o traçado; o resultado traz o novo tamanho.
 */
export async function addStroke(
  imageDataUrl: string,
  strokeWidth: number,
  color: string,
): Promise<{ image: string; width: number; height: number }> {
  const img = await loadImage(imageDataUrl);
  const sourceWidth = img.naturalWidth || img.width;
  const sourceHeight = img.naturalHeight || img.height;
  const pad = Math.ceil(strokeWidth);
  const width = sourceWidth + pad * 2;
  const height = sourceHeight + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { image: imageDataUrl, width: sourceWidth, height: sourceHeight };
  }

  ctx.drawImage(img, pad, pad, sourceWidth, sourceHeight);
  const pixels = ctx.getImageData(0, 0, width, height);
  const { data } = pixels;

  const solid = new Uint8Array(width * height);
  for (let i = 0; i < solid.length; i += 1) {
    solid[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  }

  const distances = squaredDistanceTransform(width, height, solid);
  const sr = parseInt(color.slice(1, 3), 16);
  const sg = parseInt(color.slice(3, 5), 16);
  const sb = parseInt(color.slice(5, 7), 16);

  for (let i = 0; i < solid.length; i += 1) {
    // Cobertura do traçado com borda suavizada de ~1px (anti-aliasing).
    const strokeAlpha = Math.max(0, Math.min(1, strokeWidth + 0.5 - Math.sqrt(distances[i]))) ;
    if (strokeAlpha === 0) {
      continue;
    }

    const index = i * 4;
    const artAlpha = data[index + 3] / 255;
    const outAlpha = artAlpha + strokeAlpha * (1 - artAlpha);
    if (outAlpha === 0) {
      continue;
    }

    const strokeWeight = (strokeAlpha * (1 - artAlpha)) / outAlpha;
    const artWeight = artAlpha / outAlpha;
    data[index] = data[index] * artWeight + sr * strokeWeight;
    data[index + 1] = data[index + 1] * artWeight + sg * strokeWeight;
    data[index + 2] = data[index + 2] * artWeight + sb * strokeWeight;
    data[index + 3] = outAlpha * 255;
  }

  ctx.putImageData(pixels, 0, 0);
  return { image: canvas.toDataURL('image/png'), width, height };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load image'));
    image.src = src;
  });
}
