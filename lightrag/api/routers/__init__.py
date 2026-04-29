"""
This module contains all the routers for the LightRAG API.
"""

from .document_routes import router as document_router
from .query_routes import router as query_router
from .graph_routes import router as graph_router
from .share_routes import router as share_router
from .question_pool_routes import create_question_pool_routes
from .ollama_api import OllamaAPI

__all__ = [
    "document_router",
    "query_router",
    "graph_router",
    "share_router",
    "create_question_pool_routes",
    "OllamaAPI",
]
