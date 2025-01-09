import { JSONParser } from "@streamparser/json";
import { fromEvent, Observable, switchMap } from "rxjs";
import { AzureTtsNode } from "../ai-bar/lib/elements/azure-tts-node";
import type { LlmNode } from "../ai-bar/lib/elements/llm-node";
import { system, user } from "../ai-bar/lib/message";
import { $ } from "../dom";
import { currentWorldXML } from "./shared";

export function useDiscussionOutput() {
  const simulateButton = $<HTMLButtonElement>("#simulate")!;
  const dialoguePrompt = $<HTMLInputElement>("#dialogue-prompt")!;
  const llmNode = $<LlmNode>("llm-node")!;
  const azureTtsNode = $<AzureTtsNode>("azure-tts-node")!;

  const discuss$ = fromEvent(simulateButton, "click").pipe(
    switchMap(() => {
      let result = "";

      return new Observable<{ speaker: string; utterance: string }>((subscriber) => {
        const parser = new JSONParser();
        parser.onValue = (value) => {
          if (typeof value.key === "number" && typeof value.value === "object") {
            const { speaker, utterance } = value.value as any;
            console.log([speaker, utterance]);
            azureTtsNode.queue(utterance);
            subscriber.next({ speaker, utterance });
          }
        };

        const abortController = new AbortController();
        const responseStream = llmNode
          .getClient("aoai")
          .chat.completions.create(
            {
              stream: true,
              messages: [
                system`
Simulate a dialogue based on the user provided world model. 

The dialogue must involve exactly two participants. The concrete persona of each participant depends on the specific requirement, but their abstract roles must be these:
- Participant 1 is the expert, who is knowledgeable about the world model, provides authoritative answers, confident, and good listener.
- Participant 2 is the novice, who is curious, takes the initiative to ask questions, and is eager to learn.

The dialogue must meet this requirement: ${dialoguePrompt.value.length ? dialoguePrompt.value : "related to the world model"}

Respond in this JSON format;
{
  utterances: {
    speaker: "expert" | "novice";
    utterance: string;
  }[]
}
`,
                user`${currentWorldXML.value}.
                
Now respond with the FULL dialogue. Do NOT stop until the entire dialogue is complete.
                `,
              ],
              max_tokens: 4000,
              model: "gpt-4o",
              response_format: {
                type: "json_object",
              },
            },
            {
              signal: abortController.signal,
            },
          )
          .then(async (res) => {
            for await (const chunk of res) {
              const delta = chunk.choices.at(0)?.delta?.content ?? "";
              if (!delta) continue;

              parser.write(delta);
            }
            parser.end();
          })
          .catch((err) => {
            parser.end();
          })
          .finally(() => {
            subscriber.complete();
          });

        return () => abortController.abort();
      });
    }),
  );

  return discuss$;
}
