import { useEffect, useState, type ReactNode } from 'react';
import { getBytes, type ArtifactFile } from '../../lib/api';
import { Empty } from '../../components/page';
import { BinaryCard } from '../Code';
import { Stage } from './Stage';

/** A font's own letters, at three sizes, from the file itself. */
export function FontStage({ file, name }: { file: ArtifactFile; name: string }) {
  const [family, setFamily] = useState<string | null | false>(null);
  useEffect(() => {
    let live = true;
    void getBytes(`/blob/${file.sha}`).then(async (buf) => {
      const fam = `yan-preview-${file.sha.slice(0, 12)}`;
      const face = new FontFace(fam, buf);
      await face.load();
      document.fonts.add(face);
      if (live) setFamily(fam);
    }).catch(() => {
      if (live) setFamily(false);
    });
    return () => {
      live = false;
    };
  }, [file.sha]);
  if (family === false) return <Stage><BinaryCard name={name} size={file.size} /></Stage>;
  if (family === null) return <Stage><Empty>Loading the font…</Empty></Stage>;
  const sample = (px: number, text: string): ReactNode => <div className="wrap-anywhere" style={{ fontFamily: `"${family}"`, fontSize: `${px}px`, lineHeight: 1.35 }}>{text}</div>;
  return (
    <Stage>
      <div className="flex w-[min(900px,100%)] flex-col gap-3.5 rounded-[14px] bg-card px-8 py-7 ring-1 ring-border">
        <span className="text-[12.5px] text-ink-3">{name}</span>
        {sample(44, '永和九年 Aa Bb 0123')}
        {sample(24, '天地玄黄，宇宙洪荒。The quick brown fox jumps over the lazy dog.')}
        {sample(16, '一切有为法，如梦幻泡影。ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 ,.;:!?()[]{}')}
      </div>
    </Stage>
  );
}
