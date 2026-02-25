from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import store
from ..schemas import CreateTemplateRequest, TemplateResponse, UpdateTemplateRequest

router = APIRouter(prefix="/api/v1/templates", tags=["templates"])


def _to_response(record: dict) -> TemplateResponse:
    return TemplateResponse(
        id=record["id"],
        name=record["name"],
        type=record["type"],
        content=record["content"],
        build_args=record.get("buildArgs", {}),
        default_volumes=record.get("defaultVolumes", []),
        default_env=record.get("defaultEnv", {}),
        created_at=record["createdAt"],
        updated_at=record["updatedAt"],
    )


@router.get("", response_model=list[TemplateResponse])
async def list_templates():
    return [_to_response(t) for t in store.list_templates()]


@router.post("", response_model=TemplateResponse, status_code=201)
async def create_template(req: CreateTemplateRequest):
    record = store.create_template(
        {
            "name": req.name,
            "type": req.type,
            "content": req.content,
            "buildArgs": req.build_args,
            "defaultVolumes": req.default_volumes,
            "defaultEnv": req.default_env,
        }
    )
    return _to_response(record)


@router.get("/{template_id}", response_model=TemplateResponse)
async def get_template(template_id: str):
    record = store.get_template(template_id)
    if not record:
        raise HTTPException(404, f"Template {template_id} not found")
    return _to_response(record)


@router.put("/{template_id}", response_model=TemplateResponse)
async def update_template(template_id: str, req: UpdateTemplateRequest):
    updates = {}
    if req.name is not None:
        updates["name"] = req.name
    if req.type is not None:
        updates["type"] = req.type
    if req.content is not None:
        updates["content"] = req.content
    if req.build_args is not None:
        updates["buildArgs"] = req.build_args
    if req.default_volumes is not None:
        updates["defaultVolumes"] = req.default_volumes
    if req.default_env is not None:
        updates["defaultEnv"] = req.default_env

    record = store.update_template(template_id, updates)
    if not record:
        raise HTTPException(404, f"Template {template_id} not found")
    return _to_response(record)


@router.delete("/{template_id}", status_code=204)
async def delete_template(template_id: str):
    if not store.delete_template(template_id):
        raise HTTPException(404, f"Template {template_id} not found")
