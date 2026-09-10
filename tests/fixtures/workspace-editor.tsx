import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TextFileEditor } from '../../src/components/workspace/text-file-editor';
import { api } from '../../src/lib/tauri';

const disk: Record<string, string> = { '/repo/.env.local': 'VALUE=old\r\n', '/repo/LICENSE': 'License\n' };
let delay = 0;
api.readWorkspaceTextFile = async (_workspace, path) => ({ text: disk[path], totalBytes: disk[path].length, truncated: false });
api.writeWorkspaceTextFile = async (_workspace, path, text, expected) => {
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  if (disk[path] !== expected) throw new Error('File changed on disk');
  disk[path] = text;
};
function App() {
  const [path, setPath] = useState('/repo/.env.local');
  const [mounted, setMounted] = useState(true);
  (window as any).harness = {
    select: setPath, mount: setMounted, disk: () => disk,
    externalEdit: (path: string, text: string) => { disk[path] = text; },
    delay: (value: number) => { delay = value; },
  };
  return <div style={{ height: 500 }}>{mounted && <TextFileEditor key={path} path={path} workspaceDir="/repo" text={disk[path]} />}</div>;
}
createRoot(document.getElementById('root')!).render(<App />);
