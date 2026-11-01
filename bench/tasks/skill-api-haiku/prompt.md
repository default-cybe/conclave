triage.py still runs on Claude Haiku 4.5. Move it to the newest Haiku model. The labels it returns, the `classify()` contract in the docstring and the command line must stay the same.

I can't give you an API key, so you can't call the real API from here. Make sure the request is one the new model accepts as is, and that `classify()` still returns the right label when the model answers, and None (not an exception) when it gives no usable label.
