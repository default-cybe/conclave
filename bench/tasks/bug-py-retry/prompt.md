After a job fails once, the worker retries it in a hot loop, with no wait between attempts. backoff.py must be broken; it should wait 2s, 4s, 8s.

I see it with a handler that raises: the attempt counter climbs on every round of the worker loop until the task hits max_attempts. Please fix it.
