import type { DownedVerb } from "@dotbot/game/types";
import { itemFamily, itemGlyph, itemLabel } from "../items";
import type { BodyPrompt, DownedSelf } from "./prompt";

/**
 * The two prompts that sit over a body, and the one that sits over your own.
 *
 * Drawn as marks rather than as panels: a key cap, a word, and nothing around
 * them. The old strips were bordered cards with a hard offset drop shadow, which
 * fought the world's single light from the north-west and read as chrome laid on
 * top of the drawing instead of part of it.
 *
 * Everything here is decided in `prompt.ts` — these components choose no rules.
 */

/** A key cap that is also the touch target, because a phone has no F key. */
function Key({ code, label, onPress, disabled }: {
  code: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="prompt-key"
      onPointerDown={(event) => {
        event.preventDefault();
        if (!disabled) onPress();
      }}
      // Blurred immediately: a focused button eats the next Space as a re-click
      // instead of a dash.
      onClick={(event) => event.currentTarget.blur()}
      disabled={disabled}
      aria-label={label}
    >
      <kbd>{code}</kbd>
      <span>{label}</span>
    </button>
  );
}

const VERB_WORD: Record<DownedVerb, string> = { loot: "SEARCHING", revive: "PICKING UP" };

export function BodyPromptView({ prompt, onVerb, onTake, onTakeAll }: {
  prompt: BodyPrompt;
  onVerb: (verb: DownedVerb) => void;
  onTake: (bodyId: string, index: number) => void;
  onTakeAll: (bodyId: string) => void;
}) {
  if (prompt.kind === "none") return null;

  if (prompt.kind === "channel") {
    // The ring at the body is already counting. This only has to name the verb.
    return (
      <div className="body-prompt" aria-live="polite">
        <p className="prompt-line">{VERB_WORD[prompt.verb]} {prompt.bodyName.toUpperCase()}</p>
      </div>
    );
  }

  if (prompt.kind === "verbs") {
    return (
      <div className="body-prompt">
        <p className="prompt-line">
          {prompt.bodyName.toUpperCase()}
          <span>{prompt.carriedCount > 0 ? `${prompt.carriedCount} CARRIED` : "EMPTY"}</span>
        </p>
        <div className="prompt-keys">
          <Key code="F" label="SEARCH" onPress={() => onVerb("loot")} />
          <Key code="R" label="PICK UP" onPress={() => onVerb("revive")} />
        </div>
      </div>
    );
  }

  const full = prompt.room <= 0;
  return (
    <div className="body-prompt is-open">
      <p className="prompt-line">
        {prompt.bodyName.toUpperCase()}
        <span>{prompt.items.length === 0 ? "STRIPPED" : full ? "NO ROOM" : `ROOM FOR ${prompt.room}`}</span>
      </p>
      {prompt.items.length > 0 ? (
        <ul className="loot-row">
          {prompt.items.map((item, index) => (
            <li key={`${itemLabel(item)}-${index}`}>
              <button
                type="button"
                className={`loot-slot ${itemFamily(item)}`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  if (!full) onTake(prompt.bodyId, index);
                }}
                onClick={(event) => event.currentTarget.blur()}
                disabled={full}
                aria-label={`Take ${itemLabel(item)}`}
                title={itemLabel(item)}
              >{itemGlyph(item)}</button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="prompt-keys">
        {prompt.items.length > 0 ? (
          <Key code="F" label="TAKE ALL" onPress={() => onTakeAll(prompt.bodyId)} disabled={full} />
        ) : null}
        <Key code="R" label="PICK UP" onPress={() => onVerb("revive")} />
      </div>
    </div>
  );
}

function watchLine(self: DownedSelf): string {
  if (self.watching) return `WATCHING ${self.watching.toUpperCase()}`;
  return self.rescuers > 0 ? "WATCHING YOUR BODY" : "NOBODY LEFT TO COME BACK";
}

/**
 * What you can do while you are down: wait, plea, or leave.
 *
 * No revive button, because reviving is not yours to do — a squadmate stands on
 * you. And no GIVE UP, which named a thing that no longer exists: nothing can
 * finish you off, so leaving is a decision rather than a defeat.
 */
export function DownedSelfView({ self, onPlea, onLeave }: {
  self: DownedSelf;
  onPlea: () => void;
  onLeave: () => void;
}) {
  if (self.beingRevived) {
    return (
      <div className="downed-self" aria-live="polite">
        <p className="prompt-title">BEING PICKED UP</p>
      </div>
    );
  }

  const pleaLabel = self.pleaReady ? "PLEA" : `PLEA ${Math.ceil(self.pleaReadyInMs / 1000)}`;
  return (
    <div className="downed-self">
      <p className="prompt-title">DOWNED</p>
      <p className="prompt-line">
        {self.rescuers > 0
          ? `${self.rescuers} ${self.rescuers === 1 ? "SQUADMATE" : "SQUADMATES"} STILL UP`
          : "PLEA FOR A PICKUP, OR LEAVE"}
        <span>{watchLine(self)}</span>
      </p>
      <div className="prompt-keys">
        <Key code="P" label={pleaLabel} onPress={onPlea} disabled={!self.pleaReady} />
        <button
          type="button"
          className="prompt-text-action"
          onClick={(event) => {
            event.currentTarget.blur();
            onLeave();
          }}
        >LEAVE RUN</button>
      </div>
    </div>
  );
}
