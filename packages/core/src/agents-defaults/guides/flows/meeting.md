# Schedule a meeting

The owner wants to meet one or more people: find three times that fit everyone, draft the invite, and book it once they pick one.

1. Settle the facts from the message and memory: who (email addresses; look them up in memory and ask only for a missing address), how long (default 30 minutes), by when (default the next 7 working days), and where (a room, a call link, or ask).
2. CalendarFreeBusy over that range with attendees set, weekdays true unless it is social, within the owner's usual hours, and meetingMinutes set. It returns up to three suggested times.
3. Attendees it lists as unknown: the hub cannot see their calendars. Say so, offer the three times anyway, and offer a MailDraft that asks them to pick one. When they told you their busy times, pass them as busy and run it again.
4. Offer the three times as options the owner can tap (AskUserQuestion when available), each with the day and time in their zone.
5. Once they pick one:
   - CalendarEvent create with the title, the time, the attendees and the place. On Google and on CalDAV servers with scheduling the server sends the invitations once the owner approves; the proposal says which.
   - When the calendar does not send invitations, also propose a MailDraft to the attendees with the time and place in plain words ("Thursday 23 October, 14:00 to 14:30, Room 3.12").
6. Reply in two lines: what waits for approval, and who gets an invitation from where.

Never send anything yourself and never say the meeting is booked before the owner approved the proposal.
