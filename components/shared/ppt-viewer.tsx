"use client";

import { useState } from "react";
import { ExternalLink, EyeOff, FileWarning, Presentation } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function PptViewer({ url, embedUrl }: { url: string | null; embedUrl: string | null }) {
  const [show, setShow] = useState(true);

  if (!url) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
          <FileWarning className="size-5 text-warning" />
          No presentation was submitted.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Presentation className="size-4" /> Presentation
        </CardTitle>
        <CardAction className="flex gap-2">
          {embedUrl && (
            <Button variant="ghost" size="sm" onClick={() => setShow((s) => !s)}>
              <EyeOff /> {show ? "Hide preview" : "Show preview"}
            </Button>
          )}
          <a href={url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: "sm" })}>
            Open PPT <ExternalLink />
          </a>
        </CardAction>
      </CardHeader>
      {embedUrl && show ? (
        <CardContent>
          <div className="aspect-video w-full overflow-hidden rounded-lg border bg-muted">
            <iframe
              src={embedUrl}
              title="Presentation preview"
              className="size-full"
              allow="autoplay; fullscreen"
              allowFullScreen
              referrerPolicy="no-referrer"
              // The built-in PDF viewer doesn't run inside a sandboxed frame; our own route is trusted.
              sandbox={embedUrl.startsWith("/") ? undefined : "allow-scripts allow-same-origin allow-popups allow-presentation"}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Preview not loading? Make sure the file is shared with the service account — or use “Open PPT”.
          </p>
        </CardContent>
      ) : (
        !embedUrl && (
          <CardContent className="text-sm text-muted-foreground">
            An inline preview isn’t available for this link. Use “Open PPT”.
          </CardContent>
        )
      )}
    </Card>
  );
}
