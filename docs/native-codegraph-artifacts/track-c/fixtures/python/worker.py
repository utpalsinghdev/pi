def normalize_job(job_name: str) -> str:
    return job_name.strip().lower()


def dispatch_job(job_name: str) -> str:
    normalized = normalize_job(job_name)
    return publish_job(normalized)


def publish_job(name: str) -> str:
    return name
