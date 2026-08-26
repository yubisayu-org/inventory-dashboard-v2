-- Retire the saved copies of the old refund messages.
--
-- Both WhatsApp refund templates used to open with "barang tidak tersedia"
-- whatever had happened, and a copy of that wording was saved into
-- message_templates. A saved row wins over the wording in the code, so every
-- refund kept reaching the customer as an item being out of stock — a damaged
-- parcel, a lost one, an overpayment, all of them — while the same refund's
-- inbox card said what had actually happened.
--
-- The rows are also invalid under the new rules: the body has to carry {cause},
-- and these predate it, so the Settings editor would refuse to save one until
-- somebody added a token they have no reason to know about.
--
-- Deleted rather than rewritten. getMessageTemplates falls back to the wording
-- in the code when a key has no row, so absence is how a template says "use
-- theirs" — and the next edit writes a fresh row.
--
-- Only exact copies of a shipped default go. Anything the owner actually typed
-- differs from it by at least a character and stays exactly as written, to be
-- fixed by hand with the editor's own Reset to default button: a migration that
-- silently discarded someone's wording would be worse than the bug.

DELETE FROM message_templates
 WHERE key = 'refund_specific'
   AND body = E'Halo {customer} \U0001F44B\n'
              '\n'
              'Kami ingin menginformasikan bahwa barang berikut tidak tersedia dari event *{event}*:\n'
              '{itemsList}\n'
              '\n'
              'Sehingga perlu dilakukan pengembalian dana sebesar *{refundAmount}*.\n'
              '\n'
              'Mohon balas pesan ini dengan informasi berikut:\n'
              '- Nama Bank:\n'
              '- Nomor Rekening:\n'
              '- Nama Pemilik Rekening:\n'
              '\n'
              'Terima kasih \U0001F64F';

DELETE FROM message_templates
 WHERE key = 'refund_generic'
   AND body = E'Halo {customer} \U0001F44B\n'
              '\n'
              'Kami ingin menginformasikan bahwa ada barang yang tidak tersedia dari event *{event}* sehingga perlu dilakukan pengembalian dana sebesar *{refundAmount}*.\n'
              '\n'
              'Mohon balas pesan ini dengan informasi berikut:\n'
              '- Nama Bank:\n'
              '- Nomor Rekening:\n'
              '- Nama Pemilik Rekening:\n'
              '\n'
              'Terima kasih \U0001F64F';
