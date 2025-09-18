import { FormEvent, useState } from "react";
import { Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

interface PlayerSummary {
  name: string;
  points: string[];
}

interface SessionSummaryResult {
  transcript: string;
  dmSummary: string;
  summaries: PlayerSummary[];
}

const PDF_ERROR_MESSAGE = "Failed to generate PDF. Please try again.";

export default function Home() {
  const [players, setPlayers] = useState<string[]>(["", ""]);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionSummaryResult | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleDownloadPdf = async () => {
    if (!result) {
      return;
    }

    try {
      const { jsPDF } = await import("jspdf");

      const doc = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 14;
      const maxWidth = pageWidth - margin * 2;
      let cursorY = margin;
      const lineHeight = 6;

      const ensureSpace = (needed: number) => {
        if (cursorY + needed > pageHeight - margin) {
          doc.addPage();
          cursorY = margin;
        }
      };

      const addLines = (
        lines: string[],
        options: { bold?: boolean; heading?: boolean; fontSize?: number } = {}
      ) => {
        const nextFontSize = options.fontSize ?? (options.heading ? 16 : 12);
        doc.setFontSize(nextFontSize);
        doc.setFont("helvetica", options.bold ? "bold" : "normal");

        for (const line of lines) {
          ensureSpace(lineHeight);
          doc.text(line, margin, cursorY);
          cursorY += lineHeight;
        }
        ensureSpace(2);
        cursorY += 2;
      };

      const addParagraph = (
        text: string,
        options?: { bold?: boolean; heading?: boolean; fontSize?: number }
      ) => {
        if (!text.trim()) {
          return;
        }
        const lines = doc.splitTextToSize(text.trim(), maxWidth);
        addLines(lines, options ?? {});
      };

      const addSectionHeading = (heading: string) => {
        addParagraph(heading, { bold: true, heading: true });
      };

      const addBulletPoints = (points: string[]) => {
        for (const point of points) {
          if (!point.trim()) continue;
          const bulletLines = doc.splitTextToSize(point.trim(), maxWidth - 6);
          ensureSpace(lineHeight * bulletLines.length + 2);
          doc.setFontSize(12);
          doc.setFont("helvetica", "normal");
          doc.text("•", margin, cursorY);
          doc.text(bulletLines[0], margin + 4, cursorY);
          cursorY += lineHeight;

          for (const continuation of bulletLines.slice(1)) {
            ensureSpace(lineHeight);
            doc.text(continuation, margin + 7, cursorY);
            cursorY += lineHeight;
          }

          cursorY += 2;
        }
      };

      addParagraph("Party Chronicle", { bold: true, heading: true, fontSize: 18 });
      addParagraph(`Generated ${new Date().toLocaleString()}`, { fontSize: 10 });

      addSectionHeading("Dungeon Master's Overview");
      addParagraph(result.dmSummary);

      addSectionHeading("Player Summaries");
      for (const summary of result.summaries) {
        addParagraph(summary.name, { bold: true });
        addBulletPoints(summary.points);
      }

      if (result.transcript.trim()) {
        addSectionHeading("Transcript");
        const transcriptLines = doc.splitTextToSize(result.transcript.trim(), maxWidth);
        addLines(transcriptLines);
      }

      const sessionDate = new Date().toISOString().slice(0, 10);
      doc.save(`session-summary-${sessionDate}.pdf`);
      setError((previous) => (previous === PDF_ERROR_MESSAGE ? null : previous));
    } catch (pdfError) {
      console.error("Failed to generate PDF", pdfError);
      setError(PDF_ERROR_MESSAGE);
    }
  };

  const handlePlayerChange = (index: number, value: string) => {
    setPlayers((prev) => prev.map((player, idx) => (idx === index ? value : player)));
  };

  const addPlayer = () => {
    setPlayers((prev) => [...prev, ""]);
  };

  const removePlayer = (index: number) => {
    setPlayers((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!audioFile) {
      setError("Please upload an audio file for the session.");
      return;
    }

    const cleanedPlayers = players.map((player) => player.trim()).filter(Boolean);
    if (cleanedPlayers.length === 0) {
      setError("Please provide at least one player name.");
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      setResult(null);
      setStatusMessage("Uploading audio...");

      const formData = new FormData();
      formData.append("audio", audioFile);
      formData.append("players", JSON.stringify(cleanedPlayers));

      const response = await fetch("/api/session-summary", {
        method: "POST",
        body: formData,
      });

      if (!response.ok && !response.body) {
        const payload = await response.json();
        throw new Error(payload.error || "An unexpected error occurred.");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "An unexpected error occurred.");
        }
        setResult(payload as SessionSummaryResult);
        setStatusMessage(null);
        return;
      }

      const decoder = new TextDecoder();
      let buffered = "";
      let encounteredError: string | null = null;
      let streamResult: SessionSummaryResult | null = null;

      const processBuffer = async () => {
        while (buffered.includes("\n")) {
          const newlineIndex = buffered.indexOf("\n");
          const line = buffered.slice(0, newlineIndex).trim();
          buffered = buffered.slice(newlineIndex + 1);
          if (!line) continue;

          try {
            const event = JSON.parse(line) as
              | { type: "progress"; message?: string }
              | { type: "result"; payload: SessionSummaryResult }
              | { type: "error"; message?: string };

            if (event.type === "progress" && event.message) {
              setStatusMessage(event.message);
            } else if (event.type === "result") {
              streamResult = event.payload;
              setResult(event.payload);
              setStatusMessage(null);
            } else if (event.type === "error") {
              encounteredError = event.message ?? "Failed to process session.";
              setError(encounteredError);
              setStatusMessage(null);
              await reader.cancel().catch(() => undefined);
              return;
            }
          } catch (streamError) {
            console.error("Failed to parse stream chunk", streamError, { line });
          }
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          buffered += decoder.decode();
          await processBuffer();
          break;
        }

        buffered += decoder.decode(value, { stream: true });
        await processBuffer();

        if (encounteredError) {
          break;
        }
      }

      if (!streamResult) {
        const leftover = buffered.trim();
        if (leftover.length > 0) {
          try {
            const fallback = JSON.parse(leftover) as
              | { error?: unknown }
              | SessionSummaryResult
              | undefined;

            if (fallback && typeof fallback === "object") {
              if ("error" in fallback && typeof fallback.error === "string") {
                encounteredError = fallback.error;
                setError(fallback.error);
                setStatusMessage(null);
              } else if (
                "transcript" in fallback &&
                "summaries" in fallback &&
                Array.isArray((fallback as SessionSummaryResult).summaries)
              ) {
                streamResult = fallback as SessionSummaryResult;
                setResult(streamResult);
                setStatusMessage(null);
              }
            }
          } catch (fallbackError) {
            console.error("Failed to parse fallback response", fallbackError, {
              leftover,
            });
          }
        }
      }

      if (encounteredError) {
        return;
      }

      if (!encounteredError && !streamResult) {
        throw new Error("The server did not return a summary.");
      }
    } catch (apiError) {
      setError(apiError instanceof Error ? apiError.message : "Failed to process session.");
    } finally {
      setIsLoading(false);
      setStatusMessage(null);
    }
  };

  return (
    <div
      className={`${geistSans.className} ${geistMono.className} candle-flicker min-h-screen bg-[#1b1209] text-amber-100 flex items-center justify-center px-6 py-10 sm:px-10`}
    >
      <main className="relative w-full max-w-3xl">
        <div className="absolute inset-0 scale-[1.02] rounded-[36px] bg-[radial-gradient(circle_at_top,_rgba(255,235,175,0.25),_transparent_65%)] blur-3xl opacity-70" />
        <section className="relative overflow-hidden rounded-[32px] border border-amber-900/60 bg-[#2a1c14]/90 shadow-[0_40px_120px_rgba(0,0,0,0.45)] backdrop-blur-sm">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-500 via-rose-500 to-amber-500" />
          <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-amber-500/60 via-transparent to-amber-500/60" />
          <div className="relative px-8 py-12 sm:px-12">
            <header className="mb-8 text-center sm:text-left">
              <p className="text-sm uppercase tracking-[0.35em] text-amber-400/80">
                Adventurers&apos; Chorus
              </p>
              <h1 className="mt-3 text-3xl font-semibold text-amber-50 sm:text-4xl">
                Chronicle Your Party&apos;s Tale
              </h1>
              <p className="mt-4 max-w-xl text-base text-amber-200/80">
                Upload your recorded session and note the brave heroes who took part.
                We&apos;ll keep their legend ready for the next quest.
              </p>
            </header>

            <form className="grid gap-6" onSubmit={handleSubmit}>
              <label className="flex flex-col gap-2">
                <span className="text-sm font-semibold uppercase tracking-widest text-amber-300">
                  Session Audio
                </span>
                <div className="relative rounded-2xl border border-dashed border-amber-700/60 bg-[#21140f] px-4 py-6 text-center transition hover:border-amber-500 hover:bg-[#2d1c14]">
                  <input
                    type="file"
                    accept="audio/*"
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      setAudioFile(file ?? null);
                    }}
                    required
                  />
                  <p className="mt-3 text-xs uppercase tracking-[0.25em] text-amber-400/70">
                    Drag &amp; drop or click to choose a bardic tale
                  </p>
                  {audioFile && (
                    <p className="mt-2 text-xs text-amber-300/80">{audioFile.name}</p>
                  )}
                </div>
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                {players.map((player, index) => (
                  <label key={index} className="flex flex-col gap-2">
                    <span className="text-sm font-semibold uppercase tracking-widest text-amber-300">
                      {`Player ${index + 1}`}
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={player}
                        onChange={(event) => handlePlayerChange(index, event.target.value)}
                        placeholder="Name of the hero"
                        className="w-full rounded-2xl border border-amber-900/40 bg-[#20130d] px-4 py-3 text-amber-100 placeholder:text-amber-100/40 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                        required
                      />
                      {players.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removePlayer(index)}
                          className="shrink-0 rounded-full border border-amber-500/40 px-3 py-2 text-xs uppercase tracking-[0.25em] text-amber-300 transition hover:border-amber-500 hover:text-amber-200"
                          aria-label={`Remove Player ${index + 1}`}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </label>
                ))}
              </div>

              <button
                type="button"
                onClick={addPlayer}
                className="w-full rounded-2xl border border-dashed border-amber-700/60 bg-[#1f130d] px-4 py-3 text-sm uppercase tracking-[0.3em] text-amber-300 transition hover:border-amber-500 hover:text-amber-200"
              >
                Add Another Player
              </button>

              {error && (
                <p className="rounded-2xl border border-rose-700/60 bg-rose-950/60 px-4 py-3 text-sm text-rose-200">
                  {error}
                </p>
              )}

              {statusMessage && (
                <p className="rounded-2xl border border-amber-700/60 bg-[#21140f] px-4 py-3 text-sm text-amber-200/90">
                  {statusMessage}
                </p>
              )}

              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs uppercase tracking-[0.25em] text-amber-300/70">
                  When ready, seal the record of this adventure.
                </p>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="inline-flex items-center gap-3 rounded-full border border-amber-500/80 bg-gradient-to-r from-amber-600 via-rose-600 to-amber-600 px-6 py-3 text-sm font-semibold uppercase tracking-[0.3em] text-amber-50 shadow-lg shadow-rose-900/40 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isLoading ? "Summoning..." : "Submit Chronicle"}
                </button>
              </div>
            </form>

            {result && (
              <section className="mt-10 space-y-6 rounded-2xl border border-amber-800/60 bg-[#22140f]/90 p-6">
                <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-2xl font-semibold text-amber-100">Party Chronicle</h2>
                    <p className="mt-2 text-sm text-amber-300/80">
                      Each player&apos;s deeds, recorded for posterity.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleDownloadPdf}
                    className="inline-flex items-center justify-center rounded-full border border-amber-500/80 bg-[#2a1c14] px-5 py-2 text-xs font-semibold uppercase tracking-[0.25em] text-amber-200 transition hover:border-amber-400 hover:text-amber-50"
                  >
                    Download PDF
                  </button>
                </header>

                <div className="space-y-4">
                  {result.dmSummary && (
                    <article className="rounded-2xl border border-amber-900/50 bg-[#1c120c] px-5 py-4">
                      <h3 className="text-lg font-semibold text-amber-200">Dungeon Master&apos;s Overview</h3>
                      <p className="mt-3 whitespace-pre-wrap text-sm text-amber-100/90">
                        {result.dmSummary}
                      </p>
                    </article>
                  )}

                  {result.summaries.map((summary) => (
                    <article
                      key={summary.name}
                      className="rounded-2xl border border-amber-900/50 bg-[#1c120c] px-5 py-4"
                    >
                      <h3 className="text-lg font-semibold text-amber-200">
                        {summary.name}
                      </h3>
                      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-amber-100/90">
                        {summary.points.map((point, index) => (
                          <li key={index}>{point}</li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>

                <details className="rounded-2xl border border-amber-900/40 bg-[#1a100b] px-5 py-4 text-sm text-amber-300/80">
                  <summary className="cursor-pointer text-amber-200">View full transcript</summary>
                  <p className="mt-3 whitespace-pre-wrap text-amber-100/80">{result.transcript}</p>
                </details>
              </section>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
