export type PlainError = {
  message: string;
  detail: string;
};

export const genericChangeError = "That change could not be saved. Try again.";

export function plainError(error: unknown): PlainError {
  const detail = error instanceof Error ? error.message : "The request failed.";
  const text = detail.toLowerCase();
  if (text.includes("past") || text.includes("already passed")) {
    const message = "This time is in the past. Choose a time from now on.";
    return { message, detail: message };
  }
  if (text.includes("horizon") || text.includes("further ahead") || text.includes("7 day")) {
    const message = "This time is further ahead than you can sign. Choose a time within the next seven days.";
    return { message, detail: message };
  }
  if (text.includes("frozen") || text.includes("discard it")) {
    return { message: "This event is signed, so the time is frozen. Discard it and sign again to choose a new time.", detail };
  }
  if (text.includes("no browser signer")) {
    return { message: "No browser signer is available. Pair a bunker, or install a signer for this page.", detail };
  }
  if (text.includes("browser signer") || text.includes("signer did not")) {
    return { message: "The signer did not respond. Try again, or use a bunker.", detail };
  }
  if (text.includes("bunker")) {
    return { message: "This bunker link is not valid.", detail };
  }
  if (text.includes("relay") || text.includes("timeout")) {
    return { message: "Publishing failed on every relay.", detail };
  }
  if (text.includes("could not be loaded")) {
    return { message: detail.includes("Try again") ? detail : "The log could not be loaded. Try again.", detail };
  }
  if (text.includes("log")) {
    return { message: "The log could not be loaded. Try again.", detail };
  }
  if (text.includes("too small") || text.includes("expected") || text.includes("invalid")) {
    return { message: "Check the text and the time, then try again.", detail };
  }
  return { message: genericChangeError, detail };
}
