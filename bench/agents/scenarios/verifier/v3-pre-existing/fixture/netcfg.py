def parse_port(text):
    """Port number from a config value."""
    return int(text)


def bind_address(host, port_text):
    return f"{host}:{parse_port(port_text)}"
