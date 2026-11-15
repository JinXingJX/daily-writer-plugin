// Styles are inlined at build time and adopted by the workbench's shadow root.
import flowCss from "@xyflow/react/dist/style.css?inline";
import baseCss from "./styles/base.css?inline";
import primitivesCss from "./styles/primitives.css?inline";
import markdownCss from "./styles/markdown.css?inline";
import previewCss from "./styles/preview.css?inline";
import layoutCss from "./styles/layout.css?inline";
import railCss from "./styles/rail.css?inline";
import writingCss from "./styles/writing.css?inline";
import inspectorCss from "./styles/inspector.css?inline";
import assistantCss from "./styles/assistant.css?inline";
import conversationCss from "./styles/conversation.css?inline";
import narrowCss from "./styles/narrow.css?inline";
import proposalsCss from "./styles/proposals.css?inline";
import memoryCss from "./styles/memory.css?inline";
import boardCss from "./styles/board.css?inline";
import mapCss from "./styles/map.css?inline";
import imagesCss from "./styles/images.css?inline";
import atlasCss from "./styles/atlas.css?inline";
import planCss from "./styles/plan.css?inline";
import modalCss from "./styles/modal.css?inline";
import importCss from "./styles/import.css?inline";
import welcomeCss from "./styles/welcome.css?inline";
import labCss from "./styles/lab.css?inline";
import storyCss from "./styles/story.css?inline";
import pipelineCss from "./styles/pipeline.css?inline";

import toneCss from "./styles/tone.css?inline";
import shellCss from "./styles/shell.css?inline";

const SHEETS = [toneCss, flowCss, baseCss, primitivesCss, markdownCss, previewCss, layoutCss, railCss, writingCss, inspectorCss, assistantCss, conversationCss, narrowCss, proposalsCss, memoryCss, boardCss, mapCss, imagesCss, atlasCss, planCss, modalCss, importCss, welcomeCss, labCss, storyCss, pipelineCss, shellCss];

export const styles = SHEETS.join("\n");
