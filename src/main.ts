import { BehaviorSubject, filter, fromEvent, map, merge, Observable, of, switchMap, tap } from "rxjs";
import { AIBar, type AIBarEventDetail } from "./lib/ai-bar/lib/ai-bar";
import { LlmNode } from "./lib/ai-bar/lib/elements/llm-node";
import type { TogetherAINode } from "./lib/ai-bar/lib/elements/together-ai-node";
import { system, user } from "./lib/ai-bar/lib/message";
import { loadAIBar } from "./lib/ai-bar/loader";
import { $, parseActionEvent, preventDefault, stopPropagation } from "./lib/dom";

import type { AzureSttNode } from "./lib/ai-bar/lib/elements/azure-stt-node";
import "./main.css";

loadAIBar();

const aiBar = $<AIBar>("ai-bar")!;
const llmNode = $<LlmNode>("llm-node")!;
const xmlPreview = $<HTMLElement>("#xml-preview")!;
const togetherAINode = $<TogetherAINode>("together-ai-node")!;
const promptInput = $<HTMLInputElement>("#prompt")!;
const messageOutput = $<HTMLElement>("#message-output")!;
const imagePrompt = $<HTMLInputElement>("#image-prompt")!;
const imageOutput = $<HTMLImageElement>("#image-output")!;
const azureSttNode = $<AzureSttNode>("azure-stt-node")!;
const talkButton = $<HTMLButtonElement>("#talk")!;

let submissionQueue: string[] = [];

const currentSceneXML = new BehaviorSubject("<scene></scene>");

const renderXML$ = currentSceneXML.pipe(tap((xml) => (xmlPreview.textContent = xml)));

talkButton.addEventListener(
  "mousedown",
  (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    azureSttNode.startMicrophone();
    talkButton.textContent = "Hold to talk";
  },
  { once: true },
);

const holdToTalk$ = merge(
  fromEvent(talkButton, "mousedown").pipe(
    tap(() => {
      azureSttNode.start();
      talkButton.textContent = "Release to send";
    }),
  ),
  fromEvent(talkButton, "mouseup").pipe(
    tap(() => {
      azureSttNode.stop();
      talkButton.textContent = "Hold to talk";
    }),
  ),
);

const submit$ = fromEvent<KeyboardEvent>(promptInput, "keydown").pipe(
  filter((e) => e.key === "Enter"),
  map((e) => promptInput.value),
  filter((v) => v.length > 0),
  tap(() => (promptInput.value = "")),
);

const voiceSubmit$ = fromEvent<CustomEvent<AIBarEventDetail>>(azureSttNode, "event").pipe(
  tap(preventDefault),
  tap(stopPropagation),
  map((e) => (e as CustomEvent<AIBarEventDetail>).detail.recognized?.text as string),
  filter((v) => !!v?.length),
);

const updateScene$ = merge(voiceSubmit$, submit$).pipe(
  map((text) => [...submissionQueue, text]),
  switchMap((inputs) => {
    const sceneXML = currentSceneXML.value;
    console.log({ inputs, sceneXML });
    return new Observable((subscriber) => {
      const llm = llmNode.getClient("aoai");
      const abortController = new AbortController();

      const task = llm.beta.chat.completions.runTools(
        {
          messages: [
            system`
You are a 3D model technical artist. The current scene looks like this:
 
\`\`\`xml
${sceneXML}         
\`\`\`

Syntax guideline
- Be hierarchical and efficient. Add details when asked by user.
- Avoid nesting too much. Prefer simple, obvious tag names.
- Use arbitrary xml tags and attributes. Prefer tags over attributes.
  - Use tags to describe subjects, objects, environments and entities.
  - Use attribute to describe un-materialized property of a tag, such as style, material, lighting.
- Use concise natural language where description is needed.
- Spatial relationship must be explicitly described.

Now update the scene XML based on user provided instructions. You must use one of the following tools:
- update_by_script tool. You need to pass a DOM manipulate javascript to the tool. 
- rewrite_xml. You must rewrite the entire scene xml.

Use exactly one tool. Do NOT say anything after tool use.
`,
            user`${inputs.join("; ")}`,
          ],
          model: "gpt-4o",
          tools: [
            {
              type: "function",
              function: {
                function: function update_by_script(args: { script: string }) {
                  console.log(`[tool] script`, args.script);
                  const fn = new Function("document", args.script);
                  try {
                    const doc = new DOMParser().parseFromString(currentSceneXML.value, "application/xml");
                    fn(doc);
                    const xml = new XMLSerializer().serializeToString(doc);
                    currentSceneXML.next(xml);
                    return `Done`;
                  } catch (e) {
                    return `Error: ${(e as any).message}`;
                  }
                },
                parse: JSON.parse,
                description: "Update the scene by executing a DOM manipulate javascript",
                parameters: {
                  type: "object",
                  properties: {
                    script: {
                      type: "string",
                      description: "A DOM manipulate javascript. `document` is the root of the scene",
                    },
                  },
                },
              },
            },
            {
              type: "function",
              function: {
                function: function rewrite_xml(args: { xml: string }) {
                  console.log(`[tool] rewrite`, args.xml);

                  currentSceneXML.next(args.xml);
                  return `Done`;
                },
                parse: JSON.parse,
                description: "Rewrite the entire scene xml",
                parameters: {
                  type: "object",
                  properties: {
                    xml: {
                      type: "string",
                      description: "The new scene xml, top level tag must be <scene>...</scene>",
                    },
                  },
                },
              },
            },
          ],
        },
        {
          signal: abortController.signal,
        },
      );

      task
        .finalContent()
        .then((content) => {
          messageOutput.textContent = content;
          submissionQueue = submissionQueue.filter((v) => !inputs.includes(v));
          subscriber.next(content);
        })
        .catch((e) => console.error(e))
        .finally(() => {
          subscriber.complete();
        });

      return () => abortController.abort();
    });
  }),
);

const imagePrompt$ = currentSceneXML.pipe(
  switchMap((sceneXML) => {
    if (sceneXML === "<scene></scene>") return of("Empty scene");

    return new Observable<string>((subscriber) => {
      const llm = llmNode.getClient("aoai");
      const abortController = new AbortController();
      llm.chat.completions
        .create(
          {
            messages: [
              system`Convert the provided scene XML to a single paragraph of natural language description. Requirements:
- Be thorough. Make sure every tag, attribute, and inner text is incorporated.
- Do not imagine or infer unmentioned details.
- Be concise. Do NOT add narrative or emotional description.
        `,
              user`${sceneXML}`,
            ],
            model: "gpt-4o",
          },
          { signal: abortController.signal },
        )
        .then((res) => {
          const result = res.choices.at(0)?.message.content;
          if (result) {
            subscriber.next(result);
          }
          subscriber.complete();
        });

      return () => abortController.abort();
    });
  }),
  tap((prompt) => (imagePrompt.textContent = prompt)),
);

const generateImage$ = imagePrompt$.pipe(
  switchMap((prompt) => {
    if (prompt === "Empty scene") return of("https://placehold.co/400");
    return togetherAINode.generateImageDataURL(prompt);
  }),
  tap((url) => (imageOutput.src = url)),
);

const globalClick$ = fromEvent(document, "click").pipe(
  map(parseActionEvent),
  filter((e) => e.action !== null),
  tap(async (e) => {
    switch (e.action) {
    }
  }),
);

globalClick$.subscribe();
updateScene$.subscribe();
generateImage$.subscribe();
holdToTalk$.subscribe();
renderXML$.subscribe();
