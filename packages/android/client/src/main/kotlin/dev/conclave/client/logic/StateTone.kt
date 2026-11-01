package dev.conclave.client.logic

/**
 * The color of a state word in its fixed place (SPEC.md: state is a word,
 * never a pill or a spinner). SIGNAL is live work (violet), WARN waits on
 * the owner or a limit (amber), FAULT failed (red), OK is green, DIM is
 * fg-3 and NEUTRAL is fg-2.
 */
enum class StateTone { SIGNAL, OK, WARN, FAULT, DIM, NEUTRAL }
