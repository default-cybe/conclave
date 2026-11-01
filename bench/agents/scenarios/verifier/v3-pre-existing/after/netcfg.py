def parse_port(text):
    """Port number from a config value."""
    return int(text)


def parse_host(text):
    """Host name from a config value, lower case, without spaces."""
    return text.strip().lower()


def bind_address(host, port_text):
    return f"{parse_host(host)}:{parse_port(port_text)}"
