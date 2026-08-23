# Claim resolver fixtures

Real samples, captured 2026-08-16. They exist because every resolver in this
directory has to survive WhatsApp's re-encoding, and synthetic images do not
reproduce it.

- `original.jpg` — a shelf photo as posted to a group. Downscaled from the
  4284x5712 camera original purely to keep the repository small; the resolvers
  are scale-invariant, so this costs the tests nothing.
- `ticked.jpg` — the same photo returned by a customer with two green ticks
  drawn in WhatsApp. **Do not re-encode this file.** It carries the exact
  compression artifacts (960x1280 progressive JPEG) that the ink detector must
  tolerate, and cleaning it up would make the tests pass on data no customer
  ever sends.
- `crop.jpg` — a customer's claim by cropping: a *screenshot* of a zoomed view,
  so it is double-compressed, upscaled, and a different aspect ratio from the
  original. This is the worst realistic input to the matcher, which is why it is
  the one committed.

Ground truth, measured by hand against `original.jpg`:

- `ticked.jpg` carries exactly two marks, near (41%, 77%) and (24%, 79%).
- `crop.jpg` shows the pale green floral pyjama set, which sits at roughly
  x 46-77%, y 12-34% of the original.
