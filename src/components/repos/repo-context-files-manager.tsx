"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { FileText, Trash2, Upload } from "lucide-react";

type RepoContextFileRow = {
  _id: Id<"repoContextFiles">;
  filenameOriginal: string;
  bytes: number;
  extractionStatus: "processing" | "ready" | "failed";
  extractionError?: string;
  createdAt: number;
};

const ACCEPT_ATTR = ".md,.txt,.pdf,.docx";
function isValidRepoUrl(url: string): boolean {
  const trimmed = url.trim();
  return (
    /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(trimmed) ||
    /^https?:\/\/gitlab\.com\/[\w.-]+(?:\/[\w.-]+)+(?:\.git)?\/?$/i.test(trimmed) ||
    /^https?:\/\/bitbucket\.org\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(trimmed)
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function statusBadgeVariant(status: RepoContextFileRow["extractionStatus"]) {
  if (status === "ready") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

export function RepoContextFilesManager({
  repositoryUrl,
  readOnly = false,
  title = "Repository Context Files",
}: {
  repositoryUrl: string;
  readOnly?: boolean;
  title?: string;
}) {
  const featureEnabled = process.env.NEXT_PUBLIC_ENABLE_REPO_CONTEXT_FILES === "true";
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const canUseRepo = isValidRepoUrl(repositoryUrl);

  const files = useQuery(
    api.repoContextFiles.listByRepositoryUrl,
    featureEnabled && canUseRepo ? { repositoryUrl } : "skip",
  ) as RepoContextFileRow[] | undefined;

  const generateUploadUrl = useMutation(api.repoContextFiles.generateUploadUrl);
  const finalizeUpload = useMutation(api.repoContextFiles.finalizeUpload);
  const deleteFile = useMutation(api.repoContextFiles.deleteFile);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files;
    if (!selected || selected.length === 0) return;
    if (!canUseRepo) {
      toast.error("Enter a valid repository URL first.");
      return;
    }
    setUploading(true);
    try {
      for (const file of Array.from(selected)) {
        const upload = await generateUploadUrl({ repositoryUrl });
        const uploadResponse = await fetch(upload.uploadUrl, {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
          },
          body: file,
        });
        if (!uploadResponse.ok) {
          throw new Error(`Upload failed for ${file.name}`);
        }
        const body = await uploadResponse.json() as { storageId?: string };
        if (!body.storageId) {
          throw new Error(`Upload did not return storageId for ${file.name}`);
        }
        await finalizeUpload({
          repositoryUrl,
          storageId: body.storageId as Id<"_storage">,
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          bytes: file.size,
        });
      }
      toast.success("Context file upload queued for extraction.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload context file");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async (fileId: Id<"repoContextFiles">) => {
    try {
      await deleteFile({ fileId });
      toast.success("Context file removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete file");
    }
  };

  if (!featureEnabled) return null;

  if (!canUseRepo) {
    return (
      <div className="rounded-md border p-3 space-y-2">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">
          Add a valid GitHub, GitLab, or Bitbucket URL to manage shared repo context files.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">
          Shared across all bounties in this repository. Files are injected into agent workspaces at
          <code className="ml-1">/workspace/ARCAGENT_CONTEXT</code>.
        </p>
      </div>

      {!readOnly && (
        <div className="space-y-2">
          <Label htmlFor="repo-context-upload">Upload Files</Label>
          <Input
            id="repo-context-upload"
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            multiple
            disabled={uploading}
            onChange={handleUpload}
          />
          <p className="text-xs text-muted-foreground">
            Allowed: .md, .txt, .pdf, .docx. Max 5MB per file, up to 20 files per repo.
          </p>
          {uploading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Upload className="h-3 w-3 animate-pulse" />
              Uploading and processing...
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          Existing Files
        </p>
        {files === undefined ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : files.length === 0 ? (
          <p className="text-xs text-muted-foreground">No context files uploaded yet.</p>
        ) : (
          <div className="space-y-2">
            {files.map((file) => (
              <div
                key={file._id}
                className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <p className="text-sm font-medium truncate">{file.filenameOriginal}</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatBytes(file.bytes)}</span>
                    <span>•</span>
                    <span>{new Date(file.createdAt).toLocaleString()}</span>
                  </div>
                  {file.extractionError && (
                    <p className="text-xs text-destructive">{file.extractionError}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={statusBadgeVariant(file.extractionStatus)}>
                    {file.extractionStatus}
                  </Badge>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(file._id)}
                      title="Delete file"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
