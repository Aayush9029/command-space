from pathlib import Path
import sys


def main():
    destination = Path(sys.argv[1])
    template = Path(__file__).with_name("super-space.desktop.in").read_text()
    destination.write_text(template.replace("@HOME@", str(Path.home())))


if __name__ == "__main__":
    main()
