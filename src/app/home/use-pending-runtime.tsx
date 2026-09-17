"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MODEL_CHOICE,
  type ModelChoice,
  type BackendId,
} from "@/lib/types";
import {
  matchRuntimePreset,
  useCliAgentSettings,
} from "@/lib/runtime-settings";
import { type RuntimeSwitchTarget } from "@/components/chat/backend-picker";
import { mergeStoredModelChoice } from "@/lib/model-choice";
import { loadBackendChoice, saveBackendChoice } from "@/lib/backend-choice";

export function usePendingRuntime({ activeId }: { activeId: string | null }) {
  const [modelChoice, setModelChoice] =
    useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  // Backend + CLI model/effort chosen on the hero composer before a
  // conversation exists; applied to the conversation minted on first send.
  // Sticky across sessions (shared with the quick launcher) via
  // "cetus:lastBackendChoice".
  const [pendingBackend, setPendingBackend] = useState<BackendId>("pi");
  const [pendingCliModel, setPendingCliModel] = useState("");
  const [pendingCliEffort, setPendingCliEffort] = useState("");
  const onPendingTuningChange = useCallback((model: string, effort: string) => {
    setPendingCliModel(model);
    setPendingCliEffort(effort);
  }, []);
  // ⌃1…⌃9 runtime selection: the request rides a token down to the
  // BackendPicker, which holds it as pending composer state until send, using
  // the same token pattern as focusToken/quoteRequest. Preset slots carry
  // their fixed model/effort along.
  const [backendSwitch, setBackendSwitch] = useState<
    ({ token: number } & RuntimeSwitchTarget) | null
  >(null);
  const backendSwitchToken = useRef(0);
  const requestBackendSwitch = useCallback((target: RuntimeSwitchTarget) => {
    backendSwitchToken.current += 1;
    setBackendSwitch({ token: backendSwitchToken.current, ...target });
  }, []);
  useEffect(() => {
    setModelChoice(mergeStoredModelChoice);
    const savedBackend = loadBackendChoice();
    if (savedBackend) {
      setPendingBackend(savedBackend.backend);
      setPendingCliModel(savedBackend.cliModel);
      setPendingCliEffort(savedBackend.cliEffort);
    }
  }, []);
  // Persist the new-chat runtime choice on every change past hydration (the
  // same skip-first-run dance as modelChoice below). A selection that matches
  // a preset is saved as that preset, so it never overwrites the runtime's
  // own sticky tuning — the plain runtime row keeps its separate choice.
  const cliAgentSettings = useCliAgentSettings();
  const backendChoiceHydrated = useRef(false);
  useEffect(() => {
    if (!backendChoiceHydrated.current) {
      backendChoiceHydrated.current = true;
      return;
    }
    // The settings arriving async also re-run this effect; skip no-op saves
    // so re-hydrated values aren't misclassified before the preset list loads.
    const stored = loadBackendChoice();
    if (
      stored?.backend === pendingBackend &&
      stored.cliModel === pendingCliModel &&
      stored.cliEffort === pendingCliEffort
    ) {
      return;
    }
    saveBackendChoice(
      {
        backend: pendingBackend,
        cliModel: pendingCliModel,
        cliEffort: pendingCliEffort,
      },
      matchRuntimePreset(
        cliAgentSettings.runtimePresets,
        pendingBackend,
        pendingCliModel,
        pendingCliEffort,
      )?.id,
    );
  }, [pendingBackend, pendingCliModel, pendingCliEffort, cliAgentSettings]);
  // The sticky new-chat model/reasoning choice ("cetus:lastModelChoice",
  // shared with the quick launcher) only follows *explicit* picks — the
  // composer picker (onModelChange) and the launcher's own picker. Opening an
  // existing conversation adopts that conversation's model into the composer
  // but must not overwrite the sticky choice, otherwise the last chat the user
  // happened to look at (or the one restored on launch) would silently become
  // the default for every new chat. Landing back on the new-chat hero restores
  // the sticky choice for the same reason.
  useEffect(() => {
    if (activeId !== null) return;
    setModelChoice(mergeStoredModelChoice(DEFAULT_MODEL_CHOICE));
    // Existing-chat CLI picks update the stored per-runtime tuning. Refresh
    // the hero too, otherwise it keeps the values from before that chat.
    const savedBackend = loadBackendChoice();
    if (savedBackend) {
      setPendingBackend(savedBackend.backend);
      setPendingCliModel(savedBackend.cliModel);
      setPendingCliEffort(savedBackend.cliEffort);
    }
  }, [activeId]);
  return {
    setModelChoice,
    requestBackendSwitch,
    modelChoice,
    pendingBackend,
    pendingCliModel,
    pendingCliEffort,
    setPendingBackend,
    onPendingTuningChange,
    backendSwitch,
  };
}
