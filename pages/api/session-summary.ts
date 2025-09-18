import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import { promises as fsPromises } from "fs";
import formidable, { File as FormidableFile } from "formidable";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import path from "path";

interface PlayerSummary {
  name: string;
  points: string[];
}

interface SessionSummaryResponse {
  transcript: string;
  summaries: PlayerSummary[];
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

export const config = {
  api: {
    bodyParser: false,
  },
};

const ensureEnv = () => {
  if (!process.env.OPENAI_KEY) {
    throw new Error("OPENAI_KEY is not configured");
  }
};

const parseMultipart = (req: NextApiRequest) =>
  new Promise<{ fields: formidable.Fields; files: formidable.Files }>((resolve, reject) => {
    const form = formidable({
      multiples: false,
      maxFileSize: 1024 * 1024 * 100, // 100 MB limit for uploads
    });

    form.parse(req, (error, fields, files) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ fields, files });
    });
  });

const extensionFromFilename = (fileName?: string | null) => {
  if (!fileName) return "";
  const match = /\.([a-z0-9]+)$/i.exec(fileName);
  return match?.[1]?.toLowerCase() ?? "";
};

const extensionFromMime = (mimeType?: string | null) => {
  if (!mimeType) return "";
  const map: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/aac": "aac",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/flac": "flac",
  };
  return map[mimeType.toLowerCase()] ?? "";
};

const ensureExtensionOnPath = async (file: FormidableFile) => {
  const nameExt = extensionFromFilename(file.originalFilename);
  const mimeExt = extensionFromMime(file.mimetype);
  const extension = nameExt || mimeExt;

  if (!extension) {
    console.log("[session-summary] Unable to infer extension; using raw path", {
      originalFilename: file.originalFilename,
      mimetype: file.mimetype,
    });
    return file.filepath;
  }

  if (file.filepath.toLowerCase().endsWith(`.${extension}`)) {
    return file.filepath;
  }

  const newPath = `${file.filepath}.${extension}`;

  try {
    await fsPromises.rename(file.filepath, newPath);
    console.log("[session-summary] Added extension to temp file", { newPath });
    return newPath;
  } catch (renameError) {
    console.warn("[session-summary] Failed to rename file, attempting copy", renameError);
    await fsPromises.copyFile(file.filepath, newPath);
    await fsPromises.unlink(file.filepath).catch(() => undefined);
    console.log("[session-summary] Copied temp file to new path", { newPath });
    return newPath;
  }
};

const buildPrompt = (players: string[], transcript: string) => {
  return `You are preparing individualized player summaries for a tabletop RPG session.
Players: ${players.join(", ")}.
Transcript of the session:
"""
${transcript}
"""

Return a strict JSON object with the following shape (do not include any extra commentary or markdown):
{
  "players": [
    { "name": "Player name", "points": ["bullet point", "bullet point"] }
  ]
}

Rules:
- Include an entry for every player that was provided, even if they were not mentioned.
- Each player's bullet points should cover notable events.
- When an event in the transcript directly mentions a given player, give that event extra detail in that player's bullets.
- Use between 2 and 5 concise bullets per player.
- If the transcript does not mention the player at all, provide at least one bullet describing their lack of involvement or presumed presence.
- Do not fabricate events that are not supported by the transcript.`;
};

const parseSummaries = (raw: string, players: string[]): PlayerSummary[] => {
  try {
    const parsed = JSON.parse(raw) as { players?: { name?: string; points?: unknown }[] };
    if (!parsed.players || !Array.isArray(parsed.players)) {
      throw new Error("Invalid response shape");
    }

    const summaries: PlayerSummary[] = parsed.players
      .filter((entry): entry is { name: string; points: unknown } =>
        typeof entry.name === "string" && Array.isArray(entry.points)
      )
      .map((entry) => ({
        name: entry.name,
        points: (entry.points as unknown[])
          .filter((point): point is string => typeof point === "string" && point.trim().length > 0)
          .map((point) => point.trim()),
      }));

    const missingPlayers = new Set(players);
    for (const summary of summaries) {
      missingPlayers.delete(summary.name);
    }

    if (missingPlayers.size > 0) {
      for (const name of missingPlayers) {
        summaries.push({
          name,
          points: ["No summary was generated for this player."],
        });
      }
    }

    return summaries;
  } catch (error) {
    console.error("Failed to parse model response", error);
    return players.map((name) => ({
      name,
      points: ["The AI response could not be parsed."],
    }));
  }
};

const handler = async (
  req: NextApiRequest,
  res: NextApiResponse<SessionSummaryResponse | { error: string }>
) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    ensureEnv();

    console.log("[session-summary] Incoming request");

    const { fields, files } = await parseMultipart(req);

    console.log("[session-summary] Parsed multipart payload", {
      fieldKeys: Object.keys(fields),
      fileKeys: Object.keys(files),
    });

    let playerNames: string[] = [];
    const playersField = fields.players;
    if (Array.isArray(playersField)) {
      playerNames = playersField.flatMap((entry) => {
        if (typeof entry !== "string") return [];
        try {
          const parsed = JSON.parse(entry);
          if (Array.isArray(parsed)) {
            return parsed;
          }
          return [entry];
        } catch {
          return [entry];
        }
      });
    } else if (typeof playersField === "string") {
      try {
        const parsed = JSON.parse(playersField);
        if (Array.isArray(parsed)) {
          playerNames = parsed;
        } else {
          playerNames = [playersField];
        }
      } catch {
        playerNames = [playersField];
      }
    }

    if (playerNames.length === 0) {
      return res.status(400).json({ error: "At least one player name is required" });
    }

    const cleanedPlayers = playerNames
      .map((player) => player.trim())
      .filter((player) => player.length > 0);

    if (cleanedPlayers.length === 0) {
      return res.status(400).json({ error: "Player names cannot be empty" });
    }

    const audioField = (files.audio ?? files.file) as FormidableFile | FormidableFile[] | undefined;

    const audioFile: FormidableFile | undefined = Array.isArray(audioField)
      ? audioField[0]
      : audioField;

    if (!audioFile || !audioFile.filepath) {
      return res.status(400).json({ error: "Audio file is required" });
    }

    console.log("[session-summary] Received audio file", {
      originalFilename: audioFile.originalFilename,
      mimeType: audioFile.mimetype,
      size: audioFile.size,
      tempPath: audioFile.filepath,
    });

    const readablePath = await ensureExtensionOnPath(audioFile);

    console.log("[session-summary] Prepared audio for transcription", { readablePath });

    let transcriptText = "";

    try {
      const stats = await fsPromises.stat(readablePath);
      if (stats.size === 0) {
        throw new Error("Uploaded audio file is empty");
      }

      const uploadFileName =
        typeof audioFile.originalFilename === "string" && audioFile.originalFilename.trim().length > 0
          ? audioFile.originalFilename.trim()
          : path.basename(readablePath);

      console.log("[session-summary] Starting transcription", {
        fileSize: stats.size,
        uploadFileName,
      });
      const transcription = await openai.audio.transcriptions.create({
        file: await toFile(fs.createReadStream(readablePath), uploadFileName),
        model: "whisper-1",
        response_format: "json",
        temperature: 0.2,
      });

      if (!("text" in transcription) || typeof transcription.text !== "string") {
        throw new Error("Transcription response missing text field");
      }

      transcriptText = transcription.text.trim();
      console.log("[session-summary] Transcription complete", {
        transcriptLength: transcriptText.length,
      });
    } finally {
      await fsPromises.unlink(readablePath).catch(() => undefined);
    }

    if (!transcriptText) {
      return res.status(500).json({ error: "Transcription failed" });
    }

    const prompt = buildPrompt(cleanedPlayers, transcriptText);

    console.log("[session-summary] Requesting player summaries", {
      playerCount: cleanedPlayers.length,
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are a careful chronicler who writes precise, helpful bullet points about tabletop roleplaying sessions.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      return res.status(500).json({ error: "No summary returned by model" });
    }

    const summaries = parseSummaries(content, cleanedPlayers);

    const responsePayload: SessionSummaryResponse = {
      transcript: transcriptText,
      summaries,
    };

    console.log("[session-summary] Summaries generated", {
      summaryCount: summaries.length,
    });

    return res.status(200).json(responsePayload);
  } catch (error) {
    console.error("Session summary API error", error);
    const message = error instanceof Error ? error.message : "Unexpected error";
    return res.status(500).json({ error: message });
  }
};

export default handler;
