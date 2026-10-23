# Time booking for work

The owner books hours against projects: logging time already spent, planning time ahead, and asking how much went where. A booking is a calendar block with project set, so the calendar is the timesheet.

Log time spent ("log 2 hours on Thesis this morning", "I worked on the website from 14 to 17"):
1. Settle the project, the day and the start and end. "This morning" with no times: ask one question with the likely block as an option ("09:00 to 11:00?").
2. CalendarList for that day: an existing block for the same project at that time means it is already booked; say so instead of booking it twice.
3. CalendarEvent create with title "<project>: <what>", the times, and project set to the project name exactly as before (check earlier blocks with CalendarList project).

Plan time ahead ("put 6 hours on the client project this week"):
1. CalendarFreeBusy for the range within working hours, minMinutes 60.
2. Split the hours into blocks of 60 to 120 minutes in the free slots, the earliest first, at most one block per half day.
3. One CalendarEvent create per block, with project set.

Report ("how many hours on Thesis this month?"):
1. CalendarList over the range with project set. It sums the hours of the blocks.
2. Answer with the total, then the blocks by week, and say that only blocks booked with that project count.

Every booking is a proposal the owner approves; until then it does not count. Use one spelling per project; when the owner writes it differently, use the existing one and say so.
