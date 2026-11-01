Paging GET /tasks?limit=50 with next_cursor sometimes shows a task twice and skips others, mostly after bulk imports. Is limit off by one in api.py?

A client walks all tasks by passing next_cursor back as cursor until it is null. After we import a few hundred tasks at once, the client's list has duplicates and some tasks never show up. Please fix it.
