"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Code,
  ExternalLink,
  FileText,
  ImageIcon,
  Table,
  Video,
} from "lucide-react";
import { TextFileEditor } from "./text-file-editor";
import { Spinner } from "@/components/ui/spinner";
import { convertFileSrc } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/artifact";
import {
  fileExtension,
  highlightSource,
  HLJS_THEME_CLASS,
} from "@/lib/highlight";
import { useTranslation } from "@/lib/i18n";
import {
  markdownComponents,
  markdownUrlTransform,
  remarkTrimAutolinkCjk,
} from "@/lib/markdown";
import { api } from "@/lib/tauri";
import type { WorkspaceFileEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FilePreview({
  file,
  workspaceDir,
  isRemote,
}: {
  file: WorkspaceFileEntry | null;
  workspaceDir: string;
  isRemote: boolean;
}) {
  const { t } = useTranslation("chat");
  const [text, setText] = useState<string | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState<number | null>(null);
  const [modeByPath, setModeByPath] = useState<
    Record<string, "preview" | "source">
  >({});
  const ext = file ? fileExtension(file.name) : "";
  const kind = file ? previewKind(file.name) : "empty";
  const assetUrl = file && !isRemote ? convertFileSrc(file.path) : "";
  const hasSourceMode = file ? canToggleSource(kind, ext) : false;
  const mode =
    file && hasSourceMode ? (modeByPath[file.path] ?? "preview") : "preview";

  useEffect(() => {
    let alive = true;
    setText(null);
    setLoadedPath(null);
    setTextError(null);
    setTextTruncated(null);
    if (!file || !needsText(kind, mode, ext)) return;
    api
      .readWorkspaceTextFile(workspaceDir, file.path)
      .then((value) => {
        if (alive) {
          setLoadedPath(file.path);
          setText(value.text);
          setTextTruncated(value.truncated ? value.totalBytes : null);
        }
      })
      .catch((err) => {
        if (alive) setTextError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [file?.path, kind, mode, ext, workspaceDir]);

  if (!file) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-xs text-muted-foreground">
        Select a file to preview
      </div>
    );
  }

  return (
    <section className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <FilePreviewIcon kind={kind} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={file.path}>
            {file.name}
          </p>
          <p className="truncate font-mono text-2xs text-muted-foreground">
            {file.relativePath}
          </p>
        </div>
        {hasSourceMode && (
          <div className="flex h-6 shrink-0 items-center rounded-md border border-border bg-background p-0.5">
            <button
              type="button"
              data-active={mode === "preview" ? "true" : "false"}
              className="h-5 rounded-sm px-1.5 text-2xs text-muted-foreground data-[active=true]:bg-muted data-[active=true]:text-foreground"
              onClick={() =>
                setModeByPath((current) => ({
                  ...current,
                  [file.path]: "preview",
                }))
              }
            >
              Preview
            </button>
            <button
              type="button"
              data-active={mode === "source" ? "true" : "false"}
              className="h-5 rounded-sm px-1.5 text-2xs text-muted-foreground data-[active=true]:bg-muted data-[active=true]:text-foreground"
              onClick={() =>
                setModeByPath((current) => ({
                  ...current,
                  [file.path]: "source",
                }))
              }
            >
              Source
            </button>
          </div>
        )}
        {textTruncated != null && (
          <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-2xs text-amber-700 dark:text-amber-300">
            {t("workspacePanel.previewTruncated", {
              size: formatBytes(textTruncated),
            })}
          </span>
        )}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={isRemote}
          onClick={() => api.openPath(file.path).catch(console.error)}
          title={t("artifact.openExternal")}
          aria-label={t("artifact.openExternal")}
        >
          <ExternalLink className="size-3.5" />
        </Button>
      </div>
      <div
        className={cn(
          "min-h-0",
          mode === "source" || kind === "text"
            ? "overflow-hidden"
            : "overflow-auto",
        )}
      >
        {isRemote && !needsText(kind, mode, ext) ? (
          <FileDetails file={file} ext={ext} kind={kind} />
        ) : mode === "source" ? (
          <TextPreview
            text={loadedPath === file.path ? text : null}
            error={textError}
          >
            {(value) =>
              isRemote || textTruncated != null ? (
                <SourcePreview text={value} ext={ext} />
              ) : (
                <TextFileEditor
                  key={`${workspaceDir}:${file.path}`}
                  workspaceDir={workspaceDir}
                  path={file.path}
                  text={value}
                />
              )
            }
          </TextPreview>
        ) : kind === "image" ? (
          <div className="grid min-h-full place-items-center bg-muted/20 p-4">
            <img
              src={assetUrl}
              alt={file.name}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : kind === "video" ? (
          <div className="grid min-h-full place-items-center bg-black p-4">
            <video src={assetUrl} controls className="max-h-full max-w-full" />
          </div>
        ) : kind === "audio" ? (
          <div className="grid min-h-full place-items-center p-6">
            <audio src={assetUrl} controls className="w-full max-w-xl" />
          </div>
        ) : kind === "html" || kind === "pdf" ? (
          <iframe
            title={file.name}
            src={assetUrl}
            sandbox={kind === "html" ? "" : undefined}
            className="h-full min-h-[480px] w-full"
          />
        ) : kind === "markdown" ? (
          <TextPreview
            text={loadedPath === file.path ? text : null}
            error={textError}
          >
            {(value) => (
              <div className="prose prose-sm dark:prose-invert max-w-none px-5 py-4 prose-pre:bg-secondary prose-pre:text-foreground">
                <ReactMarkdown
                  remarkPlugins={[
                    [remarkGfm, { singleTilde: false }],
                    remarkCjkFriendly,
                    remarkTrimAutolinkCjk,
                  ]}
                  components={markdownComponents}
                  urlTransform={markdownUrlTransform}
                >
                  {value}
                </ReactMarkdown>
              </div>
            )}
          </TextPreview>
        ) : kind === "csv" ? (
          <TextPreview
            text={loadedPath === file.path ? text : null}
            error={textError}
          >
            {(value) => <CsvPreview text={value} />}
          </TextPreview>
        ) : kind === "text" ? (
          <TextPreview
            text={loadedPath === file.path ? text : null}
            error={textError}
          >
            {(value) =>
              isRemote || textTruncated != null ? (
                <SourcePreview text={value} ext={ext} />
              ) : (
                <TextFileEditor
                  key={`${workspaceDir}:${file.path}`}
                  workspaceDir={workspaceDir}
                  path={file.path}
                  text={value}
                />
              )
            }
          </TextPreview>
        ) : kind === "office" && canPreviewOffice(ext) ? (
          <OfficePreview file={file} assetUrl={assetUrl} ext={ext} />
        ) : (
          <FileDetails file={file} ext={ext} kind={kind} />
        )}
      </div>
    </section>
  );
}

function SourcePreview({ text, ext }: { text: string; ext: string }) {
  const html = useMemo(() => highlightSource(text, ext), [text, ext]);
  return (
    <div
      className={cn(
        "h-full min-h-0 overflow-auto bg-white text-[#24292f] dark:bg-[#0d1117] dark:text-[#c9d1d9]",
        HLJS_THEME_CLASS,
      )}
    >
      <pre className="min-h-full w-max min-w-full px-4 py-3 font-mono text-xs leading-relaxed">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

function TextPreview({
  text,
  error,
  children,
}: {
  text: string | null;
  error: string | null;
  children: (text: string) => ReactNode;
}) {
  const { t } = useTranslation("chat");
  if (error) {
    return (
      <div className="px-5 py-4 text-xs text-destructive">
        {t("artifact.readFailed", { error })}
      </div>
    );
  }
  if (text == null) {
    return (
      <div className="flex items-center gap-2 px-5 py-4 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        {t("artifact.loading")}
      </div>
    );
  }
  return <div className="h-full min-h-0">{children(text)}</div>;
}

function CsvPreview({ text }: { text: string }) {
  const rows = parseCsvPreview(text).slice(0, 80);
  return (
    <div className="p-4">
      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className={
                  rowIndex === 0 ? "bg-muted/70 font-medium" : undefined
                }
              >
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="max-w-64 border-b border-r border-border px-2 py-1 align-top"
                  >
                    <span className="line-clamp-3 break-words">{cell}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OfficePreview({
  file,
  assetUrl,
  ext,
}: {
  file: WorkspaceFileEntry;
  assetUrl: string;
  ext: string;
}) {
  const { t } = useTranslation("chat");
  const [docHtml, setDocHtml] = useState<string | null>(null);
  const [sheetRows, setSheetRows] = useState<string[][] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDocHtml(null);
    setSheetRows(null);
    setError(null);
    fetch(assetUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then(async (buffer) => {
        if (isWordExt(ext)) {
          // mammoth/xlsx are ~2MB combined; load them only when an Office file is previewed.
          const { default: mammoth } = await import("mammoth");
          const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
          if (alive) setDocHtml(result.value);
          return;
        }
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(buffer, { type: "array" });
        const firstSheetName = workbook.SheetNames[0];
        const firstSheet = firstSheetName
          ? workbook.Sheets[firstSheetName]
          : null;
        const rows = firstSheet
          ? (XLSX.utils.sheet_to_json(firstSheet, {
              header: 1,
              blankrows: false,
              defval: "",
            }) as unknown[][])
          : [];
        if (alive)
          setSheetRows(
            rows.slice(0, 120).map((row) => row.slice(0, 32).map(String)),
          );
      })
      .catch((err) => {
        if (alive) setError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [assetUrl, ext]);

  if (error) {
    return (
      <div className="p-5">
        <p className="mb-4 text-xs text-destructive">
          {t("artifact.readFailed", { error })}
        </p>
        <FileDetails file={file} ext={ext} kind="office" />
      </div>
    );
  }

  if (isWordExt(ext)) {
    if (docHtml == null) return <OfficeLoading />;
    return (
      <iframe
        title={file.name}
        sandbox=""
        className="h-full min-h-[520px] w-full bg-white"
        srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;padding:24px;color:#1f2328}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:4px 6px}</style></head><body>${docHtml}</body></html>`}
      />
    );
  }

  if (sheetRows == null) return <OfficeLoading />;
  return <SheetPreview rows={sheetRows} />;
}

function OfficeLoading() {
  const { t } = useTranslation("chat");
  return (
    <div className="flex items-center gap-2 px-5 py-4 text-xs text-muted-foreground">
      <Spinner className="size-3.5" />
      {t("artifact.loading")}
    </div>
  );
}

function SheetPreview({ rows }: { rows: string[][] }) {
  if (rows.length === 0) {
    return <p className="px-5 py-4 text-xs text-muted-foreground">No rows</p>;
  }
  return (
    <div className="p-4">
      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className={
                  rowIndex === 0 ? "bg-muted/70 font-medium" : undefined
                }
              >
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="max-w-64 border-b border-r border-border px-2 py-1 align-top"
                  >
                    <span className="line-clamp-4 break-words">{cell}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FileDetails({
  file,
  ext,
  kind,
}: {
  file: WorkspaceFileEntry;
  ext: string;
  kind: PreviewKind;
}) {
  return (
    <div className="p-5">
      <div className="max-w-xl rounded-md border border-border p-4">
        <div className="mb-4 flex items-center gap-3">
          <FilePreviewIcon kind={kind} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {ext ? ext.toUpperCase() : "File"}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-[84px_1fr] gap-x-3 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Path</dt>
          <dd className="break-all font-mono">{file.path}</dd>
          <dt className="text-muted-foreground">Size</dt>
          <dd>{formatBytes(file.sizeBytes ?? 0)}</dd>
          <dt className="text-muted-foreground">Modified</dt>
          <dd>
            {file.modifiedMs ? new Date(file.modifiedMs).toLocaleString() : "-"}
          </dd>
          {file.symlinkTarget && (
            <>
              <dt className="text-muted-foreground">Link target</dt>
              <dd className="break-all font-mono">{file.symlinkTarget}</dd>
            </>
          )}
          {file.gitStatus && (
            <>
              <dt className="text-muted-foreground">Git status</dt>
              <dd className="capitalize">{file.gitStatus}</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

type PreviewKind =
  | "empty"
  | "image"
  | "video"
  | "audio"
  | "html"
  | "pdf"
  | "markdown"
  | "csv"
  | "text"
  | "office"
  | "binary";

function FilePreviewIcon({ kind }: { kind: PreviewKind }) {
  if (kind === "image")
    return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "video" || kind === "audio")
    return <Video className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "csv" || kind === "office")
    return <Table className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "html" || kind === "text")
    return <Code className="size-4 shrink-0 text-muted-foreground" />;
  return <FileText className="size-4 shrink-0 text-muted-foreground" />;
}

function previewKind(name: string): PreviewKind {
  const ext = fileExtension(name);
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"].includes(
      ext,
    )
  )
    return "image";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (["html", "htm"].includes(ext)) return "html";
  if (ext === "pdf") return "pdf";
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (["csv", "tsv"].includes(ext)) return "csv";
  if (
    [
      "doc",
      "docx",
      "xls",
      "xlsx",
      "ppt",
      "pptx",
      "numbers",
      "pages",
      "key",
    ].includes(ext)
  )
    return "office";
  // Unknown extensions and extensionless/dotfiles are probed as text by the
  // backend, which rejects binary or unsupported encodings without data loss.
  return "text";
}

function canToggleSource(kind: PreviewKind, ext: string): boolean {
  return (
    kind === "markdown" || kind === "html" || kind === "csv" || ext === "svg"
  );
}

function needsText(
  kind: PreviewKind,
  mode: "preview" | "source",
  ext: string,
): boolean {
  return (
    kind === "markdown" ||
    kind === "text" ||
    kind === "csv" ||
    (mode === "source" && canToggleSource(kind, ext))
  );
}

function canPreviewOffice(ext: string): boolean {
  return isWordExt(ext) || isSpreadsheetExt(ext);
}

function isWordExt(ext: string): boolean {
  return ext === "docx";
}

function isSpreadsheetExt(ext: string): boolean {
  return ext === "xlsx" || ext === "xls";
}

function parseCsvPreview(text: string): string[][] {
  const delimiter = text.includes("\t") ? "\t" : ",";
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split(delimiter).slice(0, 24));
}
