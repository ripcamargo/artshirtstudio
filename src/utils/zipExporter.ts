import JSZip from 'jszip';

export async function exportZip({
  zipName,
  files,
}: {
  zipName: string;
  files: Array<{ name: string; dataUrl: string }>;
}): Promise<void> {
  const zip = new JSZip();

  for (const file of files) {
    zip.file(file.name, dataUrlToUint8Array(file.dataUrl));
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = zipName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const [, encoded] = dataUrl.split(',');
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
